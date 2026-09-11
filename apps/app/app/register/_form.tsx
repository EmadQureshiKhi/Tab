"use client";

/**
 * `RegisterForm` - the one route on this Dashboard that signs anything.
 *
 * ## Why the flow waits, and why that is not a defect
 *
 * `AgentRegistry` binds a Source Chain address by payment, not by signature. The
 * reader asks for a nonce, the registry answers with an exact Settlement amount
 * carrying that nonce in its low four digits, and the binding completes only when a
 * Verified Settlement of exactly that amount arrives from exactly that address.
 * The wait in the middle is a payment on Ethereum being observed, attested and
 * verified on Creditcoin, so the page reports where the flow is rather than
 * pretending it is instant.
 *
 * ## What this holds, and what it never touches
 *
 * The single write is `requestBinding`, sent through the reader's own EIP-1193
 * provider. Every other call is a view. Nothing here holds a key, asks for one, or
 * can move an Agent's funds, and the Settlement itself is made by the Agent from
 * its own wallet on the Source Chain, entirely outside this page.
 *
 * ## Errors are text, and they say what to do
 *
 * Each field's error is a sentence naming the corrective action, associated with
 * its input by `aria-describedby` and marked `aria-invalid`, so it reaches a screen
 * reader as the field's own description rather than as unrelated text somewhere on
 * the page. Colour is never the only signal that something is wrong.
 *
 * Requirements: 24.5, 10.1, 10.4, 10.6, 24.10
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useTransactionToast } from "../../components/shell/transaction-toast";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { createChainReader } from "../../src/dashboard/chain";
import {
  encodeRequestBinding,
  parseAddress,
  readBoundAgent,
  readPendingBinding,
  type PendingBinding,
} from "../../src/dashboard/binding";

/** How often the page re-reads the chain while waiting for the proving Settlement. */
const POLL_MS = 15_000;

/** The EIP-1193 surface this page uses. Described structurally, so no wallet library is needed. */
interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

export interface RegisterFormProps {
  readonly agentRegistry: string;
  readonly rpcUrl: string;
  readonly chainId: number;
  /** Source Chain this binding is for. Ethereum Sepolia is chainKey 1. */
  readonly chainKey: number;
  readonly chainName: string;
}

type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting" }
  | { readonly kind: "awaiting-settlement"; readonly pending: PendingBinding }
  | { readonly kind: "bound"; readonly agent: string };

export function RegisterForm({
  agentRegistry,
  rpcUrl,
  chainId,
  chainKey,
  chainName,
}: RegisterFormProps) {
  const { announce } = useTransactionToast();
  const [agentInput, setAgentInput] = useState("");
  const [ethInput, setEthInput] = useState("");
  const [agentError, setAgentError] = useState<string | undefined>(undefined);
  const [ethError, setEthError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  // Held so the poll below reads the addresses the request was actually made with,
  // rather than whatever is in the inputs when it fires.
  const confirmed = useRef<{ agent: string; ethAddress: string } | undefined>(undefined);

  const chain = useCallback(() => createChainReader({ rpcUrl }), [rpcUrl]);

  /** One read of where the binding stands. */
  const refresh = useCallback(async (): Promise<void> => {
    const target = confirmed.current;
    if (target === undefined) return;
    const reader = chain();
    const head = await reader.latestBlock();
    if (!head.ok) return;

    const bound = await readBoundAgent(
      reader,
      agentRegistry,
      chainKey,
      target.ethAddress,
      head.value.number,
    );
    if (bound.ok && bound.value !== undefined) {
      setStage({ kind: "bound", agent: bound.value });
      return;
    }

    const pending = await readPendingBinding(
      reader,
      agentRegistry,
      chainKey,
      target.ethAddress,
      target.agent,
      head.value.number,
    );
    if (pending.ok && pending.value.open) {
      setStage({ kind: "awaiting-settlement", pending: pending.value });
    }
  }, [agentRegistry, chain, chainKey]);

  // The poll runs only while a request is outstanding, and stops the moment the
  // binding lands. A page left open on a finished binding should not keep reading.
  useEffect(() => {
    if (stage.kind !== "awaiting-settlement") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [stage.kind, refresh]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);

    const agent = parseAddress(agentInput, "agent");
    const ethAddress = parseAddress(ethInput, "ethAddress");
    setAgentError(agent.ok ? undefined : agent.error.message);
    setEthError(ethAddress.ok ? undefined : ethAddress.error.message);
    if (!agent.ok || !ethAddress.ok) return;

    const injected = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
    if (injected === undefined) {
      setFormError(
        "No wallet is available in this browser. Install one, or send the requestBinding call yourself from any Creditcoin account.",
      );
      return;
    }

    setBusy(true);
    setStage({ kind: "requesting" });
    confirmed.current = { agent: agent.value, ethAddress: ethAddress.value };

    try {
      const accounts = (await injected.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts[0];
      if (from === undefined) {
        setFormError("The wallet returned no account, so there is nothing to sign with.");
        return;
      }
      if (from.toLowerCase() !== agent.value) {
        // The request must be signed by the Agent itself: `requestBinding` records
        // `msg.sender` as the Agent, so signing from another account would open a
        // request for that account instead and quietly bind the wrong identity.
        setAgentError(
          `The connected wallet is ${from.toLowerCase()}, which is not the Agent address entered. Switch the wallet to that account, or enter the connected account as the Agent.`,
        );
        return;
      }

      const walletChain = (await injected.request({ method: "eth_chainId" })) as string;
      if (Number.parseInt(walletChain, 16) !== chainId) {
        setFormError(
          `The wallet is connected to chain ${Number.parseInt(walletChain, 16)}, not Creditcoin (${chainId}). Switch networks and try again.`,
        );
        return;
      }

      /*
        The hash is kept rather than dropped. This is the one write on this page,
        and until now it returned a transaction the reader had no way to open:
        the binding then waits on a Settlement, so the request itself would
        otherwise leave no trace they could check.
      */
      const hash = (await injected.request({
        method: "eth_sendTransaction",
        params: [
          { from, to: agentRegistry, data: encodeRequestBinding(chainKey, ethAddress.value) },
        ],
      })) as unknown;
      if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
        announce({
          hash,
          title: "Binding requested",
          detail: "Settle the stated amount from that address to complete it.",
        });
      }
      await refresh();
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? `The request was not sent: ${cause.message}`
          : "The request was not sent, and the wallet gave no reason.",
      );
      setStage({ kind: "idle" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={(event) => void submit(event)} className="flex max-w-xl flex-col gap-4">
        <Field
          id="agent"
          label="Agent address on Creditcoin"
          hint="The account that will hold the credit. It must be the account you sign with."
          value={agentInput}
          onChange={setAgentInput}
          error={agentError}
        />
        <Field
          id="ethAddress"
          label={`Address on ${chainName}`}
          hint="The address you will settle from. You prove control of it by paying the exact amount below."
          value={ethInput}
          onChange={setEthInput}
          error={ethError}
        />

        {formError === undefined ? null : (
          <p role="alert" className="text-sm text-clearing-reversed">
            {formError}
          </p>
        )}

        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Waiting for the wallet" : "Request a binding nonce"}
          </Button>
        </div>
      </form>

      <div aria-live="polite" className="flex flex-col gap-4">
        {stage.kind === "awaiting-settlement" ? (
          <AwaitingSettlement pending={stage.pending} chainName={chainName} />
        ) : null}
        {stage.kind === "bound" ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 p-5">
            <h2 className="text-sm font-semibold text-foreground">Binding confirmed</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The address is now bound to{" "}
              <span className="font-mono text-xs text-foreground">{stage.agent}</span>. A Verified
              Settlement proved it, so nothing asserted this binding: it was paid for.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The exact amount to send, and what happens next. */
function AwaitingSettlement({
  pending,
  chainName,
}: {
  readonly pending: PendingBinding;
  readonly chainName: string;
}) {
  const expires = new Date(Number(pending.expiresAt) * 1000);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5">
      <h2 className="text-sm font-semibold text-foreground">Send exactly this amount</h2>
      <p className="text-sm text-muted-foreground">
        Settle from your {chainName} address for the exact amount below. The last four digits are
        the nonce this request was issued, which is what ties the payment to it. An amount that
        differs by one base unit proves nothing and binds nothing.
      </p>
      <p
        className="font-mono text-lg text-foreground"
        title={`${pending.requiredAmount.toString()} base units`}
      >
        {pending.requiredAmount.toString()} base units
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
        <dt>Nonce</dt>
        <dd className="text-foreground">{pending.nonce}</dd>
        <dt>Expires</dt>
        <dd className="text-foreground">{expires.toISOString().replace("T", " ").slice(0, 19)} UTC</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        This page re-reads the chain every 15 seconds and will report the binding as soon as the
        Verified Settlement lands. That takes as long as the Settlement needs to be observed,
        attested and proved, so it is minutes rather than seconds.
      </p>
    </div>
  );
}

/** One labelled input, with its error text bound to it by `aria-describedby`. */
function Field({
  id,
  label,
  hint,
  value,
  onChange,
  error,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
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
        placeholder="0x…"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error !== undefined}
        // Both are named, so the hint stays available after an error appears rather
        // than being replaced by it.
        aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
      />
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-clearing-reversed">
          {error}
        </p>
      )}
    </div>
  );
}
