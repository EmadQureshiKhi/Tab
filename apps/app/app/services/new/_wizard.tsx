"use client";

/**
 * Registering a Service, one decision at a time.
 *
 * ## Why a wizard rather than a form
 *
 * `registerService` takes seven arguments, two of them parallel arrays whose
 * pairing is not obvious from their names, and it is signed once. A single long
 * form would let a reader reach the wallet prompt without ever having been told
 * what a Collection Address is for. Each step here asks one thing, says why the
 * chain wants it, and refuses to advance while an answer is malformed - so the
 * wallet only ever opens on a call that will succeed.
 *
 * ## The review step is the point
 *
 * Step five shows every argument as the contract will receive it, including the
 * decoded names beside their words and the Asset-major price list written out.
 * That ordering is the one mistake this form could make that would not revert:
 * the right tools priced in the wrong Assets is a valid call. Showing the pairing
 * is how a reader can catch it, and `test/registration.test.ts` is how the code
 * cannot make it.
 *
 * ## It never simulates
 *
 * The wallet is asked to send, and what comes back is a hash. This page does not
 * claim the registration succeeded: it says the transaction was accepted, names
 * it, and points at the directory where the indexed result will appear. A
 * Dashboard that reported success from a hash would be asserting something it had
 * not read, which is the thing this whole product exists to avoid.
 */

import { useMemo, useState } from "react";
import { Check, Plus, X } from "lucide-react";

import { Button } from "../../../components/ui/button";
import { cn } from "../../../components/ui/cn";
import { CopyButton } from "../../../components/custom-ui/copy-button";
import { FOCUS_RING } from "../../../components/ui/focus-ring";
import { Link } from "../../../components/ui/link";
import { MON, MONAD_CHAINS, type ChainSpec } from "../../../components/wallet/eip1193";
import { useWallet } from "../../../components/wallet/wallet-context";
import {
  encodeRegistration,
  type AssetTerm,
  type ToolTerm,
} from "../../../src/dashboard/registration";

const STEPS = ["Connect", "Identity", "Assets", "Tools", "Review"] as const;

export interface NewServiceWizardProps {
  readonly serviceRegistry: string;
  readonly chainId: number;
  readonly chainName: string;
  readonly networkKind: "testnet" | "mainnet";
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** The Asset a fresh row starts with. On Testnet it is the mock token the deploy script shipped. */
  readonly defaultAsset: string | undefined;
}

export function NewServiceWizard({
  serviceRegistry,
  chainId,
  chainName,
  networkKind,
  rpcUrl,
  explorerUrl,
  defaultAsset,
}: NewServiceWizardProps) {
  const wallet = useWallet();
  const [step, setStep] = useState(0);

  const [name, setName] = useState("");
  const [window, setWindow] = useState("21600");
  const [assets, setAssets] = useState<AssetTerm[]>([
    { asset: defaultAsset ?? "", collection: "" },
  ]);
  const [tools, setTools] = useState<ToolTerm[]>([{ tool: "", priceBaseUnits: "" }]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const encoded = useMemo(
    () => encodeRegistration({ serviceName: name, settlementWindowSeconds: window, assets, tools }),
    [name, window, assets, tools],
  );

  const onMonad = wallet.chainId === chainId;
  const connected = wallet.account !== undefined;

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

  /** What blocks the step the reader is on, in a sentence, or nothing. */
  const blocker = ((): string | undefined => {
    if (step === 0) {
      if (!connected) return "Connect the account that will operate the Service.";
      if (!onMonad) return `Switch the wallet to ${chainName} (chain ${chainId}).`;
      return undefined;
    }
    if (step === 4) return encoded.ok ? undefined : encoded.message;
    return undefined;
  })();

  const send = async (): Promise<void> => {
    if (!encoded.ok) return;
    setFailure(undefined);
    setSending(true);
    try {
      const chain = await wallet.ensureChain(chainSpec);
      if (!chain.ok) {
        setFailure(chain.message);
        return;
      }
      const result = await wallet.send({ to: serviceRegistry, data: encoded.value.data });
      if (!result.ok) setFailure(result.message);
      else setSent(result.value);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)] lg:gap-10">
      <Stepper current={step} onPick={setStep} reached={sent === undefined ? step : STEPS.length} />

      <div className="flex min-w-0 flex-col gap-6 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-7">
        {sent !== undefined ? (
          <Sent hash={sent} serviceId={encoded.ok ? encoded.value.serviceId : ""} name={name} />
        ) : (
          <>
            {step === 0 ? (
              <ConnectStep
                chainId={chainId}
                chainName={chainName}
                chainSpec={chainSpec}
                connected={connected}
                onMonad={onMonad}
              />
            ) : null}
            {step === 1 ? (
              <IdentityStep
                name={name}
                onName={setName}
                window={window}
                onWindow={setWindow}
              />
            ) : null}
            {step === 2 ? (
              <AssetsStep
                assets={assets}
                onChange={setAssets}
                chainName={chainName}
                networkKind={networkKind}
                defaultAsset={defaultAsset}
              />
            ) : null}
            {step === 3 ? <ToolsStep tools={tools} onChange={setTools} /> : null}
            {step === 4 ? (
              <ReviewStep
                encoded={encoded}
                assets={assets}
                tools={tools}
                registry={serviceRegistry}
                chainName={chainName}
              />
            ) : null}

            {/*
              A blocker is what is still needed, not what went wrong. Drawing an
              unconnected wallet in the declined tone would report a fault to
              someone who has simply not pressed the button yet, and would leave
              nothing louder for a failure that is real.
            */}
            {blocker === undefined ? null : (
              <p className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                {blocker}
              </p>
            )}
            {failure === undefined ? null : (
              <p className="rounded-md border border-status-danger/30 bg-status-danger/5 px-3 py-2 text-xs leading-relaxed text-status-danger">
                {failure}
              </p>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-5">
              <Button
                variant="ghost"
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                disabled={step === 0}
              >
                Back
              </Button>

              {step < STEPS.length - 1 ? (
                <Button
                  variant="customTallPrimary"
                  size="tall"
                  onClick={() => setStep((current) => current + 1)}
                  disabled={blocker !== undefined}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  variant="customTallPrimary"
                  size="tall"
                  onClick={() => void send()}
                  disabled={!encoded.ok || sending || !connected}
                >
                  {sending ? "Waiting for the wallet" : `Register on ${chainName}`}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The five steps, and which one is open. Reachable backwards, never forwards. */
function Stepper({
  current,
  reached,
  onPick,
}: {
  readonly current: number;
  readonly reached: number;
  readonly onPick: (index: number) => void;
}) {
  return (
    <ol className="flex gap-2 overflow-x-auto lg:flex-col lg:gap-0 lg:overflow-visible">
      {STEPS.map((label, index) => {
        const done = index < reached;
        const here = index === current;
        return (
          <li key={label} className="shrink-0 lg:w-full">
            <button
              type="button"
              onClick={() => (done ? onPick(index) : undefined)}
              disabled={!done && !here}
              aria-current={here ? "step" : undefined}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-start transition-colors lg:border-s-2 lg:rounded-none",
                FOCUS_RING,
                here
                  ? "bg-foreground/[0.04] lg:border-s-teal-600 lg:dark:border-s-teal-400"
                  : "lg:border-s-border/70",
                done && !here ? "cursor-pointer hover:bg-foreground/[0.03]" : "",
                !done && !here ? "cursor-not-allowed opacity-55" : "",
              )}
            >
              <span
                className={cn(
                  "font-mono text-[11px] tracking-widest tabular-nums",
                  here ? "text-teal-700 dark:text-teal-400" : "text-muted-foreground",
                )}
              >
                {done && !here ? <Check className="size-3.5" aria-hidden="true" /> : String(index + 1).padStart(2, "0")}
              </span>
              <span
                className={cn(
                  "font-mono text-xs tracking-wide uppercase",
                  here ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Heading({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-host text-lg font-semibold text-foreground">{title}</h2>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  mono = true,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly mono?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full rounded-md border border-border/60 bg-[var(--panel)] px-3 py-2 text-sm text-foreground",
          "placeholder:text-muted-foreground",
          mono && "font-mono",
          FOCUS_RING,
        )}
      />
      {hint === undefined ? null : (
        <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}

function ConnectStep({
  chainId,
  chainName,
  chainSpec,
  connected,
  onMonad,
}: {
  readonly chainId: number;
  readonly chainName: string;
  readonly chainSpec: ChainSpec;
  readonly connected: boolean;
  readonly onMonad: boolean;
}) {
  const wallet = useWallet();
  return (
    <div className="flex flex-col gap-5">
      <Heading title="The account that signs is the operator">
        <code className="font-mono">ServiceRegistry</code> records the sender as the operator, and there is no setter afterwards: no
        change kind rewrites it and no administrator can move it. Whichever account signs this is the
        only one that will ever be able to queue a change to the Service, so connect the one you mean
        to keep.
      </Heading>

      <div className="flex flex-col gap-3">
        <StatusLine done={connected} text={connected ? `Connected as ${wallet.account}` : "No wallet connected"} />
        <StatusLine
          done={onMonad}
          text={
            onMonad
              ? `On ${chainName} (chain ${chainId})`
              : `Wallet is on chain ${wallet.chainId ?? "unknown"}, not ${chainName} (${chainId})`
          }
        />
      </div>

      <div className="flex flex-wrap gap-3">
        {connected ? null : (
          <Button variant="customTallPrimary" size="tall" onClick={() => void wallet.connect()}>
            Connect a wallet
          </Button>
        )}
        {connected && !onMonad ? (
          <Button
            variant="customTallSecondary"
            size="tall"
            onClick={() => void wallet.ensureChain(chainSpec)}
          >
            Switch to {chainName}
          </Button>
        ) : null}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Registration costs MON for gas and nothing else. There is no fee to this project and no
        token to hold.
      </p>
    </div>
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

function IdentityStep({
  name,
  onName,
  window,
  onWindow,
}: {
  readonly name: string;
  readonly onName: (next: string) => void;
  readonly window: string;
  readonly onWindow: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Heading title="What the Service is called, and how long a tab may stay open">
        The name is stored as 31 bytes of ascii, which is why it is short and why this site can show
        it as a word rather than a hash. The Settlement Window is how long an Open Tab may run before
        it is delinquent: shorter means you are paid sooner, longer means an Agent is less likely to
        trip over it mid-task.
      </Heading>

      <Field
        label="Service name"
        value={name}
        onChange={onName}
        placeholder="acme.transcribe"
        hint="Up to 31 ascii characters. This is the identity the chain keys everything else by."
      />
      <Field
        label="Settlement Window, in seconds"
        value={window}
        onChange={onWindow}
        placeholder="21600"
        hint="Between 1 second and 24 hours. Zero takes the registry default. 21600 is six hours."
      />
    </div>
  );
}

function AssetsStep({
  assets,
  onChange,
  chainName,
  networkKind,
  defaultAsset,
}: {
  readonly assets: readonly AssetTerm[];
  readonly onChange: (next: AssetTerm[]) => void;
  readonly chainName: string;
  readonly networkKind: "testnet" | "mainnet";
  readonly defaultAsset: string | undefined;
}) {
  const set = (index: number, patch: Partial<AssetTerm>): void => {
    onChange(assets.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="flex flex-col gap-5">
      <Heading title="Which Assets you take, and where you collect them">
        An Agent settles on {chainName}, so each Asset is a token contract on this chain and a
        Collection Address that receives it. The Collection Address is yours: Tab never holds a
        payment, and <code className="font-mono">TabSettlement</code> moves a Settlement from the Agent straight to the address
        named here in the same transaction that records it.
        {networkKind === "testnet"
          ? " On Testnet the Asset is the mock USDC the deploy script shipped, filled in below where this deployment names one."
          : " On Mainnet the Assets are USDC and AUSD."}
      </Heading>

      <div className="flex flex-col gap-4">
        {assets.map((row, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 rounded-lg border border-border/60 bg-[var(--panel)] p-4"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                Asset {index + 1}
              </span>
              {assets.length > 1 ? (
                <button
                  type="button"
                  onClick={() => onChange(assets.filter((_, at) => at !== index))}
                  aria-label={`Remove Asset ${index + 1}`}
                  className={cn("rounded p-1 text-muted-foreground hover:text-foreground", FOCUS_RING)}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <Field
              label={`Token contract on ${chainName}`}
              value={row.asset}
              onChange={(next) => set(index, { asset: next })}
              placeholder="0x…"
              hint="The ERC-20 the Service is paid in. It must have six decimals or fewer for the prices below to mean what they say."
            />
            <Field
              label="Collection Address"
              value={row.collection}
              onChange={(next) => set(index, { collection: next })}
              placeholder="0x…"
              hint="Where Settlements of this Asset are paid. This address receives your money."
            />
          </div>
        ))}
      </div>

      <Button
        variant="ghost"
        onClick={() => onChange([...assets, { asset: defaultAsset ?? "", collection: "" }])}
        className="w-fit"
      >
        <Plus className="size-4" aria-hidden="true" />
        Add another Asset
      </Button>
    </div>
  );
}

function ToolsStep({
  tools,
  onChange,
}: {
  readonly tools: readonly ToolTerm[];
  readonly onChange: (next: ToolTerm[]) => void;
}) {
  const set = (index: number, patch: Partial<ToolTerm>): void => {
    onChange(tools.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="flex flex-col gap-5">
      <Heading title="What you meter, and what each call costs">
        A price is an integer count of the Asset&apos;s smallest unit, never a decimal. USDC has six
        decimals, so one cent is 10000 and a dollar is 1000000. Integers all the way down is what
        keeps a price the same number on the chain, in the index, and on the page.
      </Heading>

      <div className="flex flex-col gap-4">
        {tools.map((row, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 rounded-lg border border-border/60 bg-[var(--panel)] p-4 sm:flex-row sm:items-end"
          >
            <div className="flex-1">
              <Field
                label="Tool name"
                value={row.tool}
                onChange={(next) => set(index, { tool: next })}
                placeholder="transcribe.audio"
              />
            </div>
            <div className="flex-1">
              <Field
                label="Price, in base units"
                value={row.priceBaseUnits}
                onChange={(next) => set(index, { priceBaseUnits: next })}
                placeholder="10000"
              />
            </div>
            {tools.length > 1 ? (
              <button
                type="button"
                onClick={() => onChange(tools.filter((_, at) => at !== index))}
                aria-label={`Remove tool ${index + 1}`}
                className={cn(
                  "mb-2 rounded p-1 text-muted-foreground hover:text-foreground",
                  FOCUS_RING,
                )}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <Button
        variant="ghost"
        onClick={() => onChange([...tools, { tool: "", priceBaseUnits: "" }])}
        className="w-fit"
      >
        <Plus className="size-4" aria-hidden="true" />
        Add another tool
      </Button>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Every tool is priced in every Asset you accept, at the figure entered here.
      </p>
    </div>
  );
}

function ReviewStep({
  encoded,
  assets,
  tools,
  registry,
  chainName,
}: {
  readonly encoded: ReturnType<typeof encodeRegistration>;
  readonly assets: readonly AssetTerm[];
  readonly tools: readonly ToolTerm[];
  readonly registry: string;
  readonly chainName: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Heading title="Exactly what the wallet will be asked to send">
        Nothing below is a summary. It is the argument list as <code className="font-mono">ServiceRegistry</code> will receive it,
        including the price ordering, which is the one mistake this form could make that would not
        revert: the right tools priced against the wrong Assets is a valid call.
      </Heading>

      {!encoded.ok ? (
        <p className="rounded-md border border-status-danger/30 bg-status-danger/5 px-3 py-2 text-xs text-status-danger">
          {encoded.message}
        </p>
      ) : (
        <>
          <dl className="flex flex-col rounded-lg border border-border/60 bg-[var(--panel)] p-4">
            <Row label="To">{registry}</Row>
            <Row label="Function">registerService</Row>
            <Row label="serviceId">{encoded.value.serviceId}</Row>
            <Row label="settlementWindow">{`${encoded.value.summary.settlementWindow} seconds`}</Row>
          </dl>

          <div className="flex flex-col gap-2">
            <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
              Prices, in the order the contract reads them
            </p>
            <ul className="flex flex-col gap-1 rounded-lg border border-border/60 bg-[var(--panel)] p-4">
              {assets.flatMap((asset, assetIndex) =>
                tools.map((tool, toolIndex) => (
                  <li
                    key={`${assetIndex}-${toolIndex}`}
                    className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/50 py-1.5 font-mono text-xs last:border-b-0"
                  >
                    <span className="text-foreground">{tool.tool || "(unnamed)"}</span>
                    <span className="text-muted-foreground">
                      {tool.priceBaseUnits || "0"} base units of {asset.asset.slice(0, 10)}… on{" "}
                      {chainName}
                    </span>
                  </li>
                )),
              )}
            </ul>
          </div>

          <div className="flex items-start justify-between gap-2 rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="min-w-0">
              <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                Calldata
              </p>
              <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">
                {encoded.value.data}
              </p>
            </div>
            <CopyButton text={encoded.value.data} label="the calldata" />
          </div>
        </>
      )}
    </div>
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

/**
 * What happened, said no more strongly than it is known.
 *
 * A hash means the wallet accepted the transaction. It does not mean the chain
 * included it, and it certainly does not mean the index has seen it. So this
 * names the hash, says what to look for, and links to the place where the
 * answer will actually be readable.
 */
function Sent({
  hash,
  serviceId,
  name,
}: {
  readonly hash: string;
  readonly serviceId: string;
  readonly name: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Heading title="The transaction was sent">
        The wallet accepted it and gave back the hash below. That is as much as this page knows: it
        has not read the chain, so it is not telling you the Service is registered. When the
        transaction is included and the index has caught up, the Service appears in the directory
        with the prices you set.
      </Heading>

      <dl className="flex flex-col rounded-lg border border-border/60 bg-[var(--panel)] p-4">
        <Row label="Transaction">{hash}</Row>
        <Row label="serviceId">{serviceId}</Row>
        <Row label="Name">{name}</Row>
      </dl>

      <div className="flex flex-wrap gap-3">
        <Button variant="customTallPrimary" size="tall" asChild>
          <a href="/services" className="no-underline">
            Open the directory
          </a>
        </Button>
        <Button variant="customTallSecondary" size="tall" asChild>
          <a href="/browse" className="no-underline">
            See it in the catalogue
          </a>
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        A registered Service has no Bond yet, and free Bond is what caps the Credit Limit an Agent
        can earn by settling with it: a limit never exceeds 95% of the counterparty&apos;s free
        stake, so a Service with nothing escrowed earns its Agents nothing. Bond is two
        transactions: approve <code className="font-mono">Bond</code> to pull the Asset, then deposit it.{" "}
        <Link href="/services/bond" size="inherit">
          Post a Bond
        </Link>
        , or see{" "}
        <Link href="/services" size="inherit">
          the Bond behind every Service
        </Link>
        .
      </p>
    </div>
  );
}
