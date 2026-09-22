"use client";

/**
 * The two transactions a Bond takes, both on Monad, both signed here.
 *
 * ## Why two, and why in this order
 *
 * `Bond.deposit` pulls the Asset from the caller with `transferFrom`, so the
 * caller has to have approved `Bond` for at least that amount first. The
 * approval is a plain ERC-20 call on the Asset contract; the deposit is the call
 * on `Bond` that escrows it. Neither is a transfer to an address somebody typed:
 * `Bond` is the deployment's own contract, and the stake it holds can only ever
 * be withdrawn by the account it was credited to.
 *
 * ## Whose stake it is
 *
 * `TabBook` reads a Service's free Bond under the Service's bond account, which
 * `ServiceRegistry` set to the operator at registration. So a deposit signed by
 * the operator uses `deposit` and lands under its own party; one signed by any
 * other wallet uses `depositFor(operator, ...)` and lands under the operator's
 * party all the same. Either way the account that can withdraw it is the
 * operator's, and the page says so before the wallet opens.
 *
 * ## It never simulates
 *
 * Each step reports the hash the wallet returned and no more. A Monad block is
 * about a second, so the second step is offered as soon as the first has a
 * hash, and the directory shows the credited stake once the index has read the
 * block. This page reads no chain and does not claim the stake landed.
 */

import { useMemo, useState } from "react";

import { Button } from "../../../components/ui/button";
import { cn } from "../../../components/ui/cn";
import { FOCUS_RING } from "../../../components/ui/focus-ring";
import { Link } from "../../../components/ui/link";
import { MON, MONAD_CHAINS } from "../../../components/wallet/eip1193";
import { useWallet } from "../../../components/wallet/wallet-context";
import { explorerTxUrl } from "../../../src/dashboard/network";
import { encodeApprove, encodeDeposit } from "../../../src/dashboard/registration";

/** One Asset a Service accepts, with the stake already behind it where the index will say. */
export interface BondAssetChoice {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Free stake in base units as a decimal string, or undefined where the index would not stand behind a figure. */
  readonly freeBaseUnits: string | undefined;
}

export interface ServiceSummary {
  readonly serviceId: string;
  readonly name: string | undefined;
  readonly operator: string;
  readonly assets: readonly BondAssetChoice[];
}

export interface BondFlowProps {
  readonly bond: string;
  readonly chainId: number;
  readonly chainName: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly services: readonly ServiceSummary[];
  readonly servicesError?: string | undefined;
}

/** Base units as a decimal, without floating point, for the sentence beside the input. */
function toDecimal(baseUnits: bigint, decimals: number): string {
  if (decimals === 0) return baseUnits.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const fraction = (baseUnits % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function BondFlow({
  bond,
  chainId,
  chainName,
  rpcUrl,
  explorerUrl,
  services,
  servicesError,
}: BondFlowProps) {
  const wallet = useWallet();
  const [serviceId, setServiceId] = useState(services[0]?.serviceId ?? "");
  const [assetIndex, setAssetIndex] = useState(0);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  const [approved, setApproved] = useState<string | undefined>(undefined);
  const [deposited, setDeposited] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const service = services.find((entry) => entry.serviceId === serviceId);
  const asset = service?.assets[assetIndex];

  const mine =
    wallet.account !== undefined &&
    service !== undefined &&
    service.operator.toLowerCase() === wallet.account;

  /*
    The chain the deployment runs on, with the deployment's own endpoint and
    explorer in place of the defaults, so a wallet that has to add the chain
    adds the one this page is reading.
  */
  const chainSpec = {
    ...(MONAD_CHAINS[chainId] ?? { id: chainId, name: chainName, currency: MON }),
    rpcUrl,
    explorerUrl,
  };

  const approveData = useMemo(() => encodeApprove(bond, amount), [bond, amount]);
  const depositData = useMemo(
    () =>
      asset === undefined || service === undefined
        ? undefined
        : encodeDeposit({
            asset: asset.address,
            baseUnits: amount,
            // The operator's party is the one `TabBook` reads, so a deposit from
            // any other wallet is credited there rather than to the signer.
            ...(mine ? {} : { account: service.operator }),
          }),
    [asset, service, amount, mine],
  );

  const parsed = /^\d+$/.test(amount.trim()) ? BigInt(amount.trim()) : undefined;

  const approve = async (): Promise<void> => {
    if (asset === undefined) return;
    setNote(undefined);
    if (!approveData.ok) {
      setNote(approveData.message);
      return;
    }
    setBusy(true);
    try {
      const chain = await wallet.ensureChain(chainSpec);
      if (!chain.ok) {
        setNote(chain.message);
        return;
      }
      const sent = await wallet.send({ to: asset.address, data: approveData.value });
      if (!sent.ok) setNote(sent.message);
      else setApproved(sent.value);
    } finally {
      setBusy(false);
    }
  };

  const deposit = async (): Promise<void> => {
    if (depositData === undefined) return;
    setNote(undefined);
    if (!depositData.ok) {
      setNote(depositData.message);
      return;
    }
    setBusy(true);
    try {
      const chain = await wallet.ensureChain(chainSpec);
      if (!chain.ok) {
        setNote(chain.message);
        return;
      }
      const sent = await wallet.send({ to: bond, data: depositData.value });
      if (!sent.ok) setNote(sent.message);
      else setDeposited(sent.value);
    } finally {
      setBusy(false);
    }
  };

  if (services.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-6 py-10 text-sm text-muted-foreground">
        {servicesError === undefined
          ? "No Service is indexed yet, so there is nothing to post a Bond against."
          : `The Service directory could not be read: ${servicesError}`}{" "}
        <Link href="/services/new" size="inherit">
          Register one first
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel step="01" title="Which Service, and which Asset">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
            Service
          </span>
          <select
            value={serviceId}
            onChange={(event) => {
              setServiceId(event.target.value);
              setAssetIndex(0);
              setApproved(undefined);
              setDeposited(undefined);
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
          <p className="text-xs text-muted-foreground">This Service accepts no Asset yet.</p>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
              Asset
            </span>
            <select
              value={String(assetIndex)}
              onChange={(event) => {
                setAssetIndex(Number.parseInt(event.target.value, 10));
                setApproved(undefined);
                setDeposited(undefined);
              }}
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

        {asset === undefined ? null : (
          <Value label={`Free Bond in ${asset.symbol} today`}>
            {asset.freeBaseUnits === undefined
              ? "not cross-checked by the index"
              : `${asset.freeBaseUnits} base units (${toDecimal(BigInt(asset.freeBaseUnits), asset.decimals)} ${asset.symbol})`}
          </Value>
        )}

        {wallet.account === undefined ? (
          <Hint>Connect a wallet to continue. Any account may fund a Service&apos;s Bond.</Hint>
        ) : mine ? (
          <Hint>
            The connected account operates this Service, so the deposit lands under its own bond
            account and it alone can withdraw it.
          </Hint>
        ) : (
          <Hint>
            This Service is operated by {service?.operator}. The deposit will be credited to that
            account with <code className="font-mono">depositFor</code>, so it is the operator, and not you, who can withdraw it.
          </Hint>
        )}
      </Panel>

      <Panel step="02" title="Approve Bond to pull the Asset" done={approved !== undefined}>
        {approved !== undefined ? (
          <Value label="Approved in">
            <Link href={explorerTxUrl(approved, explorerUrl)} external mono>
              {approved}
            </Link>
          </Value>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              A plain ERC-20 approval on the {asset?.symbol ?? "Asset"} contract, for exactly the
              amount you will deposit. <code className="font-mono">Bond</code> pulls the Asset with <code className="font-mono">transferFrom</code>, and without this
              the deposit reverts before anything moves.
            </p>
            <Value label="Spender">{bond}</Value>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                Amount, in base units
              </span>
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="5000000"
                inputMode="numeric"
                className={cn(
                  "rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground",
                  FOCUS_RING,
                )}
              />
              <span className="text-xs text-muted-foreground">
                {asset === undefined
                  ? "A whole number of the Asset's smallest unit."
                  : parsed === undefined
                    ? `${asset.symbol} has ${asset.decimals} decimals${asset.decimals === 6 ? ", so 5000000 is five dollars" : ""}.`
                    : `${toDecimal(parsed, asset.decimals)} ${asset.symbol}.`}
              </span>
            </label>
            <Button
              variant="customTallSecondary"
              size="tall"
              className="w-fit"
              disabled={busy || wallet.account === undefined || asset === undefined}
              onClick={() => void approve()}
            >
              {busy ? "Waiting for the wallet" : `Approve on ${chainName}`}
            </Button>
          </>
        )}
      </Panel>

      <Panel step="03" title="The deposit itself" done={deposited !== undefined}>
        {approved === undefined ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Approve first. Until <code className="font-mono">Bond</code> may pull the Asset, a deposit has nothing to escrow.
          </p>
        ) : deposited !== undefined ? (
          <Value label="Escrowed in">
            <Link href={explorerTxUrl(deposited, explorerUrl)} external mono>
              {deposited}
            </Link>
          </Value>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {mine
                ? "`Bond.deposit(asset, amount)`, from the operator's own wallet. The stake is credited to your bond account."
                : `\`Bond.depositFor(operator, asset, amount)\`. The stake is credited to ${service?.operator ?? "the operator"}, who alone can withdraw it.`}
            </p>
            <Value label="To">{bond}</Value>
            <Value label="Function">{mine ? "deposit(address,uint128)" : "depositFor(address,address,uint128)"}</Value>
            <Value label="Amount">
              {parsed === undefined || asset === undefined
                ? amount
                : `${parsed.toString()} base units (${toDecimal(parsed, asset.decimals)} ${asset.symbol})`}
            </Value>
            <Button
              variant="customTallPrimary"
              size="tall"
              className="w-fit"
              disabled={busy || wallet.account === undefined || depositData === undefined}
              onClick={() => void deposit()}
            >
              {busy ? "Waiting for the wallet" : `Deposit on ${chainName}`}
            </Button>
          </>
        )}
      </Panel>

      <Panel step="04" title="What happens next">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Both transactions are on {chainName}, and a block there is about a second. Once the
          deposit is included, <code className="font-mono">Bond.freeOf</code> reports the new stake and <code className="font-mono">TabBook</code> reads it the next
          time it computes a Credit Limit for an Agent that has settled with this Service. Nothing
          waits on another chain and nothing has to be proved: the escrow is the contract&apos;s own
          balance.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The directory shows the credited stake once the index has read the block. A hash on this
          page means the wallet accepted the transaction; it does not mean this page has read the
          chain.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/services" size="xs" className="font-mono">
            The Service directory
          </Link>
          <Link href="/explorer" size="xs" className="font-mono">
            The settlement explorer
          </Link>
        </div>
      </Panel>

      {note === undefined ? null : (
        <p className="rounded-md border border-status-danger/30 bg-status-danger/5 px-3 py-2 text-xs leading-relaxed text-status-danger">
          {note}
        </p>
      )}
    </div>
  );
}

function Panel({
  step,
  title,
  done = false,
  children,
}: {
  readonly step: string;
  readonly title: string;
  readonly done?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-xl border p-5 sm:p-6",
        done ? "border-teal-700/25 bg-muted/30 dark:border-teal-400/20" : "border-border/60 bg-muted/30",
      )}
    >
      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            "font-mono text-[11px] tracking-widest tabular-nums",
            done ? "text-teal-700 dark:text-teal-400" : "text-muted-foreground",
          )}
        >
          {step}
        </span>
        <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Hint({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

function Value({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2">
      <span className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
        {label}
      </span>
      <span className="font-mono text-xs break-all text-foreground">{children}</span>
    </div>
  );
}
