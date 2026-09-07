"use client";

/**
 * The two transactions a Bond takes, and the wait between them.
 *
 * The first is on Creditcoin and registers where the deposit will be collected.
 * The second is on the Source Chain and is the deposit itself, a plain ERC-20
 * transfer to that address. Nothing here calls `Bond`: it has no deposit
 * function, and the stake is credited by `fundFromVerifiedSettlement` once the
 * payment has been proved.
 *
 * The wait is drawn rather than hidden behind a spinner. A progress indicator
 * implies this page is watching something and will tell you when it changes; it
 * is not, and it cannot, because the thing being waited for is a Settlement
 * moving through observation, proof and verification. So the last step says what
 * has to happen, and points at the directory where the credited stake will
 * appear.
 *
 * Requirements: 14.1, 24.5, 24.9, 24.10
 */

import { useMemo, useState } from "react";

import { Button } from "../../../components/ui/button";
import { cn } from "../../../components/ui/cn";
import { FOCUS_RING } from "../../../components/ui/focus-ring";
import { Link } from "../../../components/ui/link";
import { useWallet } from "../../../components/wallet/wallet-context";
import { encodeBondCollection, encodeTransfer } from "../../../src/dashboard/registration";

/** EVM chain ids for the Source Chains, which are not Tab's chain keys. */
const SOURCE_CHAIN: Record<string, { readonly id: number; readonly name: string }> = {
  "1": { id: 11155111, name: "Ethereum Sepolia" },
  "3": { id: 1, name: "Ethereum Mainnet" },
};

export interface ServiceSummary {
  readonly serviceId: string;
  readonly operator: string;
  readonly assets: readonly {
    readonly chainKey: string;
    readonly asset: string;
    readonly bondCollection: string | null;
  }[];
}

export function BondFlow({
  serviceRegistry,
  chainId,
  services,
}: {
  readonly serviceRegistry: string;
  readonly chainId: number;
  readonly services: readonly ServiceSummary[];
}) {
  const wallet = useWallet();
  const [serviceId, setServiceId] = useState(services[0]?.serviceId ?? "");
  const [assetIndex, setAssetIndex] = useState(0);
  const [collection, setCollection] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  const [registered, setRegistered] = useState<string | undefined>(undefined);
  const [deposited, setDeposited] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const service = services.find((entry) => entry.serviceId === serviceId);
  const term = service?.assets[assetIndex];
  const source = term === undefined ? undefined : SOURCE_CHAIN[term.chainKey];

  /*
    An existing collection is the common case: `registerService` can set one, and
    a Service that has already posted a Bond has one. Where it exists the first
    transaction is not needed at all, and offering it anyway would ask an operator
    to pay gas to write a value that is already there.
  */
  const existing = term?.bondCollection ?? undefined;
  const target = existing ?? (registered === undefined ? undefined : collection.trim().toLowerCase());

  const mine =
    wallet.account !== undefined &&
    service !== undefined &&
    service.operator.toLowerCase() === wallet.account;

  const depositData = useMemo(
    () => (target === undefined ? undefined : encodeTransfer(target, amount)),
    [target, amount],
  );

  const registerCollection = async (): Promise<void> => {
    if (term === undefined) return;
    setNote(undefined);
    const data = encodeBondCollection({
      serviceId,
      chainKey: term.chainKey,
      asset: term.asset,
      collection,
    });
    if (!data.ok) {
      setNote(data.message);
      return;
    }
    setBusy(true);
    try {
      const chain = await wallet.ensureChain({
        id: chainId,
        name: "Creditcoin CC3 Testnet",
        rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
        currency: { name: "Creditcoin", symbol: "CTC", decimals: 18 },
      });
      if (!chain.ok) {
        setNote(chain.message);
        return;
      }
      const sent = await wallet.send({ to: serviceRegistry, data: data.value });
      if (!sent.ok) setNote(sent.message);
      else setRegistered(sent.value);
    } finally {
      setBusy(false);
    }
  };

  const deposit = async (): Promise<void> => {
    if (term === undefined || source === undefined || depositData === undefined) return;
    setNote(undefined);
    if (!depositData.ok) {
      setNote(depositData.message);
      return;
    }
    setBusy(true);
    try {
      const chain = await wallet.ensureChain({ id: source.id, name: source.name });
      if (!chain.ok) {
        setNote(chain.message);
        return;
      }
      const sent = await wallet.send({ to: term.asset, data: depositData.value });
      if (!sent.ok) setNote(sent.message);
      else setDeposited(sent.value);
    } finally {
      setBusy(false);
    }
  };

  if (services.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-6 py-10 text-sm text-muted-foreground">
        No Service is indexed yet, so there is nothing to post a Bond against.{" "}
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
            }}
            className={cn(
              "rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2 font-mono text-sm text-foreground",
              FOCUS_RING,
            )}
          >
            {services.map((entry) => (
              <option key={entry.serviceId} value={entry.serviceId}>
                {entry.serviceId}
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
              onChange={(event) => setAssetIndex(Number.parseInt(event.target.value, 10))}
              className={cn(
                "rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2 font-mono text-sm text-foreground",
                FOCUS_RING,
              )}
            >
              {service.assets.map((entry, index) => (
                <option key={`${entry.chainKey}-${entry.asset}`} value={index}>
                  {entry.asset} on {SOURCE_CHAIN[entry.chainKey]?.name ?? `chainKey ${entry.chainKey}`}
                </option>
              ))}
            </select>
          </label>
        )}

        {wallet.account === undefined ? (
          <Hint>Connect the operator&apos;s wallet to continue.</Hint>
        ) : mine ? null : (
          <Hint>
            This Service is operated by {service?.operator}. Only that account can register a Bond
            collection for it, so the first step below will be refused by the contract from any
            other.
          </Hint>
        )}
      </Panel>

      <Panel
        step="02"
        title="Where the deposit is collected"
        done={existing !== undefined || registered !== undefined}
      >
        {existing !== undefined ? (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              This Asset already has a Bond collection registered, so there is nothing to send here.
            </p>
            <Value label="Bond collection">{existing}</Value>
          </>
        ) : registered !== undefined ? (
          <Value label="Registered in">{registered}</Value>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              An address you control on {source?.name ?? "the Source Chain"}. A deposit is proved by
              the Settlement that paid it, so the chain has to be told where such a payment counts
              as your stake before you make one.
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                Bond collection address
              </span>
              <input
                value={collection}
                onChange={(event) => setCollection(event.target.value)}
                placeholder="0x…"
                className={cn(
                  "rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground",
                  FOCUS_RING,
                )}
              />
            </label>
            <Button
              variant="customTallSecondary"
              size="tall"
              className="w-fit"
              disabled={busy || wallet.account === undefined || term === undefined}
              onClick={() => void registerCollection()}
            >
              {busy ? "Waiting for the wallet" : "Register the collection on Creditcoin"}
            </Button>
          </>
        )}
      </Panel>

      <Panel step="03" title="The deposit itself" done={deposited !== undefined}>
        {target === undefined ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Register a collection above first. Until one exists there is no address a deposit could
            be proved against.
          </p>
        ) : deposited !== undefined ? (
          <Value label="Paid in">{deposited}</Value>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              A plain token transfer on {source?.name ?? "the Source Chain"}, from your own wallet to
              your own collection address. Tab never holds it, and this page never asks for an
              approval.
            </p>
            <Value label="Paying to">{target}</Value>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                Amount, in base units
              </span>
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="5000000"
                className={cn(
                  "rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground",
                  FOCUS_RING,
                )}
              />
              <span className="text-xs text-muted-foreground">
                USDC has six decimals, so 5000000 is five dollars.
              </span>
            </label>
            <Button
              variant="customTallPrimary"
              size="tall"
              className="w-fit"
              disabled={busy || wallet.account === undefined}
              onClick={() => void deposit()}
            >
              {busy ? "Waiting for the wallet" : `Deposit on ${source?.name ?? "the Source Chain"}`}
            </Button>
          </>
        )}
      </Panel>

      <Panel step="04" title="What happens next, and how long it takes">
        <p className="text-sm leading-relaxed text-muted-foreground">
          The deposit is now a payment on the Source Chain and nothing more. It becomes stake when
          that payment has been observed, proved against the Attestcoin BlockProver Precompile, and
          accepted by a Creditcoin contract, which is the same path every Settlement takes. Nothing
          on this page can shorten it, and this page is not watching for it.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          When it lands, the stake appears against the Service in the directory, and the deposit
          appears in the explorer as the Verified Settlement that proved it.
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
        <p className="rounded-md border border-clearing-declined/30 bg-clearing-declined/5 px-3 py-2 text-xs leading-relaxed text-clearing-declined">
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
