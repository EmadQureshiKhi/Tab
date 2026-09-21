"use client";

/**
 * `AuthoriseForm` - the one write an Agent makes before anything is metered.
 *
 * ## What is signed, and by whom
 *
 * `TabBook.authorise(serviceId, asset, maxCumulative, expiry)` records `msg.sender`
 * as the Agent, so the account that signs is the tab the ceiling applies to.
 * There is no Agent field to fill in: the connected account is the Agent, and
 * the page says which account that is before the wallet opens.
 *
 * ## Everything here is a read except the one call the reader signs
 *
 * The current authorisation is read from the chain for the connected account as
 * soon as a Service and an Asset are chosen, and read again after the
 * transaction until the chain reflects the new ceiling. Both are `eth_call`s
 * against a public endpoint, so the figures shown are the contract's and not
 * this page's opinion of what it sent.
 *
 * ## Errors are text, and they say what to do
 *
 * Each field's error is a sentence naming the corrective action, associated with
 * its input by `aria-describedby` and marked `aria-invalid`, so it reaches a screen
 * reader as the field's own description rather than as unrelated text somewhere on
 * the page. Colour is never the only signal that something is wrong.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Link } from "../../components/ui/link";
import { cn } from "../../components/ui/cn";
import { FOCUS_RING } from "../../components/ui/focus-ring";
import { CopyButton } from "../../components/custom-ui/copy-button";
import { MON, MONAD_CHAINS } from "../../components/wallet/eip1193";
import { useWallet } from "../../components/wallet/wallet-context";
import { createChainReader } from "../../src/dashboard/chain";
import { explorerTxUrl } from "../../src/dashboard/network";
import {
  encodeAuthorise,
  readAuthorisation,
  type AuthorisationRecord,
} from "../../src/dashboard/authorisation";

/** How often the page re-reads the chain while waiting for the authorisation to land. */
const POLL_MS = 2_000;

/** How long to keep polling after a send. Monad blocks are about a second; this is generous. */
const POLL_FOR_MS = 60_000;

/** The default expiry, in days, when the reader does not say. */
const DEFAULT_EXPIRY_DAYS = "30";

const SECONDS_PER_DAY = 86_400;

/** One Asset a Service accepts, named where the deployment can name it. */
export interface AssetChoice {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly collection: string;
}

/** One Service as the reader picks it. */
export interface ServiceChoice {
  readonly serviceId: string;
  readonly name: string | undefined;
  readonly operator: string;
  readonly settlementWindowSeconds: number;
  readonly assets: readonly AssetChoice[];
}

export interface AuthoriseFormProps {
  readonly tabBook: string;
  readonly chainId: number;
  readonly chainName: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly services: readonly ServiceChoice[];
  /** Why the directory could not be read, where it could not. */
  readonly servicesError?: string | undefined;
}

/** A whole number of base units, or the sentence that says why not. */
function parseCeiling(raw: string): { ok: true; value: bigint } | { ok: false; message: string } {
  const trimmed = raw.trim().replace(/_/g, "");
  if (trimmed.length === 0) {
    return { ok: false, message: "Enter a ceiling. It is a whole number of the Asset's smallest unit." };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message:
        "The ceiling must be a whole number of base units, with no decimal point. USDC has six decimals, so one dollar is 1000000.",
    };
  }
  const value = BigInt(trimmed);
  if (value === 0n) return { ok: false, message: "A ceiling of zero would authorise nothing." };
  if (value >= 1n << 128n) return { ok: false, message: "The ceiling must fit a uint128." };
  return { ok: true, value };
}

/** A count of days, or the sentence that says why not. */
function parseDays(raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "The expiry is a whole number of days from now." };
  }
  const days = Number.parseInt(trimmed, 10);
  if (days < 1 || days > 3650) {
    return { ok: false, message: "The expiry must be between 1 day and 10 years from now." };
  }
  return { ok: true, value: days };
}

/** Base units as a decimal, without floating point, for the preview only. */
function toDecimal(baseUnits: bigint, decimals: number): string {
  if (decimals === 0) return baseUnits.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const fraction = (baseUnits % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function utc(seconds: bigint | number): string {
  return new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent"; readonly hash: string }
  | { readonly kind: "landed"; readonly hash: string };

export function AuthoriseForm({
  tabBook,
  chainId,
  chainName,
  rpcUrl,
  explorerUrl,
  services,
  servicesError,
}: AuthoriseFormProps) {
  const wallet = useWallet();

  const [serviceId, setServiceId] = useState(services[0]?.serviceId ?? "");
  const [assetIndex, setAssetIndex] = useState(0);
  const [ceilingInput, setCeilingInput] = useState("");
  const [daysInput, setDaysInput] = useState(DEFAULT_EXPIRY_DAYS);
  const [ceilingError, setCeilingError] = useState<string | undefined>(undefined);
  const [daysError, setDaysError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [current, setCurrent] = useState<AuthorisationRecord | undefined>(undefined);
  const [currentError, setCurrentError] = useState<string | undefined>(undefined);
  // Held so the poll after a send knows what it is waiting for.
  const [expected, setExpected] = useState<{ ceiling: bigint; expiry: bigint } | undefined>(undefined);

  const service = services.find((entry) => entry.serviceId === serviceId);
  const asset = service?.assets[assetIndex];

  const connected = wallet.account !== undefined;
  const onMonad = wallet.chainId === chainId;

  const ceiling = useMemo(() => parseCeiling(ceilingInput), [ceilingInput]);
  const days = useMemo(() => parseDays(daysInput), [daysInput]);

  /*
    The expiry is fixed when the preview is built, not when the button is
    pressed, so what the reader reads in the preview is what the wallet is asked
    to sign. It is recomputed whenever the days change, which is the only input
    that moves it.
  */
  const expiry = useMemo(() => {
    if (!days.ok) return undefined;
    return BigInt(Math.floor(Date.now() / 1000) + days.value * SECONDS_PER_DAY);
  }, [days]);

  const calldata = useMemo(() => {
    if (service === undefined || asset === undefined || !ceiling.ok || expiry === undefined) return undefined;
    return encodeAuthorise(service.serviceId, asset.address, ceiling.value, expiry);
  }, [service, asset, ceiling, expiry]);

  const chain = useCallback(() => createChainReader({ rpcUrl }), [rpcUrl]);

  /** One read of the authorisation the connected account holds for this pair. */
  const refresh = useCallback(async (): Promise<AuthorisationRecord | undefined> => {
    if (wallet.account === undefined || service === undefined || asset === undefined) return undefined;
    const reader = chain();
    const head = await reader.latestBlock();
    if (!head.ok) {
      setCurrentError(`The chain could not be read: ${head.error.message}`);
      return undefined;
    }
    const record = await readAuthorisation(
      reader,
      tabBook,
      wallet.account,
      service.serviceId,
      asset.address,
      head.value.number,
    );
    if (!record.ok) {
      setCurrentError(`The authorisation could not be read: ${record.error.message}`);
      return undefined;
    }
    setCurrentError(undefined);
    setCurrent(record.value);
    return record.value;
  }, [wallet.account, service, asset, chain, tabBook]);

  // Where the reader stands, read as soon as there is enough to ask. A read,
  // not a prompt: `eth_call` against a public endpoint opens no wallet.
  useEffect(() => {
    setCurrent(undefined);
    void refresh();
  }, [refresh]);

  // After a send, re-read until the chain reflects the new ceiling or the
  // window closes. Stops the moment it lands; a page left open on a finished
  // authorisation should not keep reading.
  useEffect(() => {
    if (stage.kind !== "sent" || expected === undefined) return undefined;
    const started = Date.now();
    const timer = setInterval(() => {
      void (async () => {
        const record = await refresh();
        if (
          record !== undefined &&
          record.exists &&
          record.maxCumulative === expected.ceiling &&
          record.expiry === expected.expiry
        ) {
          setStage({ kind: "landed", hash: stage.hash });
          return;
        }
        if (Date.now() - started > POLL_FOR_MS) {
          setFormError(
            "The transaction was sent but the chain has not reflected it within a minute. Open it on the explorer to see whether it was included.",
          );
          setStage({ kind: "idle" });
        }
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [stage, expected, refresh]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    setCeilingError(ceiling.ok ? undefined : ceiling.message);
    setDaysError(days.ok ? undefined : days.message);
    if (!ceiling.ok || !days.ok || expiry === undefined) return;

    if (service === undefined || asset === undefined) {
      setFormError("Pick a Service and an Asset it accepts before signing.");
      return;
    }

    // A passkey account is a signer with no injected wallet behind it, so
    // "nothing installed" only refuses when nothing is connected either.
    if (!wallet.available && !connected) {
      setFormError(
        `No wallet is available in this browser. Install one, create a passkey account from Connect in the masthead, or send the authorise call yourself from any ${chainName} account.`,
      );
      return;
    }

    if (!connected) {
      const result = await wallet.connect();
      if (!result.ok) {
        setFormError(result.message);
        return;
      }
    }

    /*
      The chain the deployment runs on, with the deployment's own endpoint and
      explorer in place of the defaults, so a wallet that has to add the chain
      adds the one this page is reading.
    */
    const switched = await wallet.ensureChain({
      ...(MONAD_CHAINS[chainId] ?? { id: chainId, name: chainName, currency: MON }),
      rpcUrl,
      explorerUrl,
    });
    if (!switched.ok) {
      setFormError(switched.message);
      return;
    }

    const data = encodeAuthorise(service.serviceId, asset.address, ceiling.value, expiry);
    setStage({ kind: "sending" });
    setExpected({ ceiling: ceiling.value, expiry });
    const sent = await wallet.send({ to: tabBook, data });
    if (!sent.ok) {
      setFormError(sent.message);
      setStage({ kind: "idle" });
      return;
    }
    setStage({ kind: "sent", hash: sent.value });
  };

  if (services.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-6 py-10 text-sm text-muted-foreground">
        {servicesError === undefined
          ? "No Service is registered yet, so there is nothing to authorise."
          : `The Service directory could not be read: ${servicesError}`}{" "}
        <Link href="/services" size="inherit">
          The directory
        </Link>{" "}
        lists every Service as the chain holds it.
      </p>
    );
  }

  const busy = stage.kind === "sending" || stage.kind === "sent";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
      <form onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-5">
        <Panel step="01" title="The account that signs is the Agent">
          <p className="text-sm leading-relaxed text-muted-foreground">
            <code className="font-mono">authorise</code> records the sender as the Agent, so the ceiling applies to whichever
            account signs it. Connect the one whose tab the Service will meter. With a passkey
            account the signing key is the Agent: choose a session key on{" "}
            <Link href="/keys" size="inherit">
              Keys
            </Link>{" "}
            to authorise for the runtime that holds it.
          </p>
          <div className="flex flex-col gap-2">
            <StatusLine
              done={connected}
              text={
                connected
                  ? `Connected as ${wallet.account}${wallet.kind === "passkey" ? ` (passkey, ${wallet.passkey.active?.label.toLowerCase() ?? "no key"})` : ""}`
                  : "No wallet connected"
              }
            />
            <StatusLine
              done={connected && onMonad}
              text={
                !connected
                  ? `${chainName} (chain ${chainId})`
                  : onMonad
                    ? `On ${chainName} (chain ${chainId})`
                    : `Wallet is on chain ${wallet.chainId ?? "unknown"}, not ${chainName} (${chainId})`
              }
            />
          </div>
          {connected ? null : (
            <div>
              <Button
                type="button"
                variant="customTallSecondary"
                size="tall"
                onClick={() =>
                  void wallet.connect().then((result) => {
                    // A refusal names what to do, and it belongs on this page
                    // rather than only in the masthead menu the reader has not opened.
                    setFormError(result.ok ? undefined : result.message);
                  })
                }
                disabled={wallet.connecting}
              >
                {wallet.connecting
                  ? "Waiting for the wallet"
                  : wallet.passkey.remembered !== undefined && !wallet.available
                    ? "Use your passkey"
                    : "Connect a wallet"}
              </Button>
            </div>
          )}
        </Panel>

        <Panel step="02" title="Which Service, in which Asset">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
              Service
            </span>
            <select
              value={serviceId}
              onChange={(event) => {
                setServiceId(event.target.value);
                setAssetIndex(0);
              }}
              className={cn(
                "rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2 font-mono text-sm text-foreground",
                FOCUS_RING,
              )}
            >
              {services.map((entry) => (
                <option key={entry.serviceId} value={entry.serviceId}>
                  {entry.name ?? entry.serviceId}
                </option>
              ))}
            </select>
          </label>

          {service === undefined || service.assets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              This Service accepts no Asset yet, so there is nothing it could charge in.
            </p>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                Asset
              </span>
              <select
                value={String(assetIndex)}
                onChange={(event) => setAssetIndex(Number.parseInt(event.target.value, 10))}
                className={cn(
                  "rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2 font-mono text-sm text-foreground",
                  FOCUS_RING,
                )}
              >
                {service.assets.map((entry, index) => (
                  <option key={entry.address} value={index}>
                    {entry.symbol} · {entry.address}
                  </option>
                ))}
              </select>
            </label>
          )}

          {service === undefined ? null : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Operated by <span className="font-mono">{service.operator}</span>. Its Settlement
              Window is {Math.round(service.settlementWindowSeconds / 3600)} hours, which is how
              long a charge may stay open before anyone may mark the tab delinquent.
            </p>
          )}
        </Panel>

        <Panel step="03" title="How much, until when">
          <Field
            id="ceiling"
            label={`Ceiling, in ${asset?.symbol ?? "Asset"} base units`}
            hint={
              asset === undefined
                ? "The most this Service may charge in total, as a whole number of the Asset's smallest unit."
                : `The most this Service may charge in total. ${asset.symbol} has ${asset.decimals} decimals${asset.decimals === 6 ? ", so 5000000 is five dollars" : ""}.`
            }
            value={ceilingInput}
            onChange={setCeilingInput}
            placeholder="5000000"
            error={ceilingError}
          />
          <Field
            id="expiry"
            label="Expires in, days"
            hint="After this the Service cannot charge, whatever is left of the ceiling. Sign again to extend it."
            value={daysInput}
            onChange={setDaysInput}
            placeholder={DEFAULT_EXPIRY_DAYS}
            error={daysError}
          />
        </Panel>

        {formError === undefined ? null : (
          <p role="alert" className="rounded-md border border-status-danger/30 bg-status-danger/5 px-3 py-2 text-sm text-status-danger">
            {formError}
          </p>
        )}

        <div>
          <Button type="submit" variant="customTallPrimary" size="tall" disabled={busy}>
            {stage.kind === "sending"
              ? "Waiting for the wallet"
              : stage.kind === "sent"
                ? "Waiting for the block"
                : "Sign the authorisation"}
          </Button>
        </div>
      </form>

      <div className="flex min-w-0 flex-col gap-5">
        <Preview
          tabBook={tabBook}
          service={service}
          asset={asset}
          ceiling={ceiling.ok ? ceiling.value : undefined}
          expiry={expiry}
          calldata={calldata}
        />

        <div aria-live="polite" className="flex flex-col gap-5">
          <Standing
            record={current}
            error={currentError}
            asset={asset}
            connected={connected}
            landed={stage.kind === "landed"}
          />

          {stage.kind === "sent" || stage.kind === "landed" ? (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-5">
              <h2 className="text-sm font-semibold text-foreground">
                {stage.kind === "landed" ? "Authorisation recorded" : "Transaction sent"}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {stage.kind === "landed"
                  ? "The chain now holds the ceiling above. This page read it back from TabBook; it is not repeating what it sent."
                  : "The wallet accepted it. This page re-reads the chain every two seconds and will report the ceiling once a block has carried it."}
              </p>
              <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
                <Link href={explorerTxUrl(stage.hash, explorerUrl)} external mono>
                  {stage.hash}
                </Link>
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Exactly what the wallet will be asked to send, before it is asked. */
function Preview({
  tabBook,
  service,
  asset,
  ceiling,
  expiry,
  calldata,
}: {
  readonly tabBook: string;
  readonly service: ServiceChoice | undefined;
  readonly asset: AssetChoice | undefined;
  readonly ceiling: bigint | undefined;
  readonly expiry: bigint | undefined;
  readonly calldata: string | undefined;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">
          What the wallet will be asked to send
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Nothing below is a summary. It is the argument list as <code className="font-mono">TabBook</code> will receive it.
        </p>
      </div>
      <dl className="flex flex-col rounded-lg border border-border/60 bg-[var(--panel)] px-4">
        <Row label="To">{tabBook}</Row>
        <Row label="Function">authorise(bytes32,address,uint128,uint64)</Row>
        <Row label="serviceId">{service?.serviceId ?? "pick a Service"}</Row>
        <Row label="asset">{asset?.address ?? "pick an Asset"}</Row>
        <Row label="maxCumulative">
          {ceiling === undefined || asset === undefined
            ? "enter a ceiling"
            : `${ceiling.toString()} base units (${toDecimal(ceiling, asset.decimals)} ${asset.symbol})`}
        </Row>
        <Row label="expiry">
          {expiry === undefined ? "enter an expiry" : `${expiry.toString()} (${utc(expiry)})`}
        </Row>
      </dl>
      {calldata === undefined ? null : (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-border/60 bg-background/60 p-3">
          <div className="min-w-0">
            <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
              Calldata
            </p>
            <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">{calldata}</p>
          </div>
          <CopyButton text={calldata} label="the calldata" />
        </div>
      )}
    </section>
  );
}

/** The authorisation the connected account holds now, as the contract reports it. */
function Standing({
  record,
  error,
  asset,
  connected,
  landed,
}: {
  readonly record: AuthorisationRecord | undefined;
  readonly error: string | undefined;
  readonly asset: AssetChoice | undefined;
  readonly connected: boolean;
  readonly landed: boolean;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-5 sm:p-6",
        landed ? "border-teal-700/25 bg-muted/30 dark:border-teal-400/20" : "border-border/60 bg-muted/30",
      )}
    >
      <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">
        Where you stand, read from the chain
      </h2>
      {!connected ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Connect a wallet and this reads the authorisation that account holds for the chosen
          Service and Asset. It is a read against a public endpoint, and it opens no wallet dialog.
        </p>
      ) : error !== undefined ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{error}</p>
      ) : record === undefined ? (
        <p className="text-sm leading-relaxed text-muted-foreground">Reading <code className="font-mono">TabBook</code>.</p>
      ) : !record.exists ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          No authorisation exists for this account, Service and Asset. Until one does,
          <code className="font-mono">recordDelivery</code> refuses every delivery the Service tries to meter.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          <dt>Ceiling</dt>
          <dd className="text-foreground">
            {record.maxCumulative.toString()} base units
            {asset === undefined ? "" : ` (${toDecimal(record.maxCumulative, asset.decimals)} ${asset.symbol})`}
          </dd>
          <dt>Spent against it</dt>
          <dd className="text-foreground">
            {record.spent.toString()} base units
            {asset === undefined ? "" : ` (${toDecimal(record.spent, asset.decimals)} ${asset.symbol})`}
          </dd>
          <dt>Expires</dt>
          <dd className="text-foreground">{utc(record.expiry)}</dd>
          <dt>Headroom</dt>
          <dd className="text-foreground">
            {(record.maxCumulative > record.spent ? record.maxCumulative - record.spent : 0n).toString()}{" "}
            base units
          </dd>
        </dl>
      )}
    </section>
  );
}

function Panel({
  step,
  title,
  children,
}: {
  readonly step: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-6">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] tracking-widest text-muted-foreground tabular-nums">
          {step}
        </span>
        <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function StatusLine({ done, text }: { readonly done: boolean; readonly text: string }) {
  return (
    <p className="flex items-center gap-2.5 font-mono text-xs">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          done ? "bg-teal-600 dark:bg-teal-400" : "bg-muted-foreground/50",
        )}
      />
      <span className={cn("break-all", done ? "text-foreground" : "text-muted-foreground")}>{text}</span>
    </p>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border/50 py-2 last:border-b-0">
      <dt className="font-mono text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono text-xs break-all text-foreground">{children}</dd>
    </div>
  );
}

/** One labelled input, with its error text tied to it by `aria-describedby`. */
function Field({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  error,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
  readonly error: string | undefined;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        inputMode="numeric"
        aria-invalid={error !== undefined}
        // Both are named, so the hint stays available after an error appears rather
        // than being replaced by it.
        aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
      />
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}
