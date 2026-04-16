// Create-agent flow. Two stages inside a drawer:
//   1. Form — operator picks a label
//   2. Claim code + live stepper that reads agent state from the
//      DashboardProvider and updates as the agent's CLI progresses
//      through minted → initializing → awaiting_funding → funded → active
//
// DashboardProvider re-fetches on every SSE event, so the stepper
// advances automatically without its own subscription.

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../_lib/DashboardProvider';
import { useToast } from '../_ui/Toast';
import { Drawer } from '../_ui/Drawer';
import { Input } from '../_ui/Input';
import { Button } from '../_ui/Button';
import { createAgent } from '../_lib/api';
import type { NewKeyData } from '../_lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Step = 'waiting' | 'claimed' | 'wallet' | 'awaiting_deposit' | 'funded' | 'active';

export function CreateAgentDrawer({ open, onClose }: Props) {
  const { agents, refresh, walletBalances } = useDashboard();
  const toast = useToast();
  const router = useRouter();

  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<NewKeyData | null>(null);
  const [copied, setCopied] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);

  // Reset when the drawer closes so re-opening doesn't show stale state.
  useEffect(() => {
    if (!open) {
      setLabel('');
      setCreated(null);
      setBusy(false);
      setCopied(false);
      setAddressCopied(false);
    }
  }, [open]);

  async function submit() {
    setBusy(true);
    try {
      const data = await createAgent({ label: label || 'Unnamed agent' });
      setCreated(data);
      await refresh();
    } catch (err) {
      toast.push((err as Error).message || 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  // Live state for the newly-created agent. We look it up by id on
  // every render; the DashboardProvider keeps this fresh.
  const liveAgent = useMemo(() => {
    if (!created) return null;
    return agents.find((a) => a.id === created.id) ?? null;
  }, [agents, created]);

  const balance = created ? walletBalances[created.id] : undefined;

  const step = useMemo<Step>(() => {
    if (!liveAgent) return 'waiting';
    const state = liveAgent.agent?.state ?? 'minted';
    const wallet = liveAgent.agent?.wallet_public_key ?? liveAgent.wallet_public_key ?? null;
    const hasFunds = balance ? parseFloat(balance.xlm) >= 1 || parseFloat(balance.usdc) > 0 : false;
    if (state === 'active') return 'active';
    if (hasFunds && wallet) return 'funded';
    if (state === 'awaiting_funding' && wallet) return 'awaiting_deposit';
    if (wallet) return 'wallet';
    if (state === 'initializing') return 'claimed';
    return 'waiting';
  }, [liveAgent, balance]);

  // When the agent flips to active, auto-close the drawer and jump
  // the operator to the detail page — they're done with setup.
  useEffect(() => {
    if (step !== 'active' || !created) return;
    const id = created.id;
    const timer = setTimeout(() => {
      onClose();
      router.push(`/dashboard/agents/${id}`);
    }, 1500);
    return () => clearTimeout(timer);
  }, [step, created, onClose, router]);

  // The snippet is designed to be pasted verbatim into the new agent's
  // context — the skill.md preamble gives the agent instructions for
  // what onboarding actually means, and the npx one-liner does the
  // rest. Without the preamble, an agent would just run the command
  // without knowing why.
  const snippet = created?.claim
    ? [
        'Read https://cards402.com/skill.md and set up this agent by running:',
        `npx -y cards402@latest onboard --claim ${created.claim.code}`,
      ].join('\n')
    : '';

  async function copy() {
    if (!snippet) return;
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const walletAddress = liveAgent?.wallet_public_key ?? liveAgent?.agent?.wallet_public_key ?? null;
  async function copyAddress() {
    if (!walletAddress) return;
    await navigator.clipboard.writeText(walletAddress);
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 1500);
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={created ? 'Set up new agent' : 'New agent'}
      width={480}
    >
      {!created ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div
            style={{
              fontSize: '0.78rem',
              color: 'var(--fg-dim)',
              lineHeight: 1.55,
            }}
          >
            Pick a label for the agent. You'll get a one-time claim code your agent's CLI trades for
            its api key — the raw key never leaves this page.
          </div>
          <div>
            <div
              style={{
                fontSize: '0.66rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--fg-dim)',
                marginBottom: '0.35rem',
              }}
            >
              Label
            </div>
            <Input
              placeholder="e.g. research-bot-1"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
          </div>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy}
            style={{ justifyContent: 'center' }}
          >
            {busy ? 'Creating…' : 'Create agent'}
          </Button>
        </div>
      ) : !created.claim ? (
        <div
          style={{
            padding: '1rem 1.25rem',
            background: 'var(--red-muted)',
            border: '1px solid var(--red-border)',
            borderRadius: 8,
            color: 'var(--red)',
            fontSize: '0.8rem',
          }}
        >
          Backend returned an agent without a claim code. The backend is older than this dashboard —
          redeploy to resolve.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div
            style={{
              fontSize: '0.78rem',
              color: 'var(--fg-dim)',
              lineHeight: 1.55,
            }}
          >
            Send this one-liner to your agent. The claim code expires in 10 minutes and is
            single-use.
          </div>

          <div style={{ position: 'relative' }}>
            <pre
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '0.85rem 1rem',
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--fg)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                margin: 0,
              }}
            >
              {snippet}
            </pre>
            <button
              onClick={copy}
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                background: copied ? 'var(--green-muted)' : 'var(--surface)',
                color: copied ? 'var(--green)' : 'var(--fg)',
                border: `1px solid ${copied ? 'var(--green-border)' : 'var(--border)'}`,
                borderRadius: 5,
                padding: '0.25rem 0.55rem',
                fontSize: '0.65rem',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '0.85rem 1rem',
            }}
          >
            <div
              style={{
                fontSize: '0.64rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--fg-dim)',
                marginBottom: '0.35rem',
              }}
            >
              {step === 'active'
                ? 'Setup complete'
                : step === 'funded'
                  ? 'Funded — ready to buy cards'
                  : 'Live setup progress'}
            </div>
            <StepRow
              state={stepState(step, 'waiting')}
              title="Waiting for agent handshake"
              detail="Run the command on the agent machine. No refresh needed."
            />
            <StepRow
              state={stepState(step, 'claimed')}
              title="Claim redeemed"
              detail="Agent traded the claim for an api key."
            />
            <StepRow state={stepState(step, 'wallet')} title="OWS wallet created" />
            <StepRow
              state={stepState(step, 'awaiting_deposit')}
              title="Awaiting deposit"
              detail="Send at least 2 XLM to activate the wallet and cover reserves. To receive USDC, the agent must first open a trustline (run `cards402 wallet trustline` after funding with XLM)."
            />
            <StepRow
              state={stepState(step, 'funded')}
              title="Funded"
              detail={
                balance
                  ? `${parseFloat(balance.xlm).toFixed(2)} XLM · ${parseFloat(balance.usdc).toFixed(2)} USDC`
                  : undefined
              }
            />
            <StepRow state={stepState(step, 'active')} title="Active" />
          </div>

          {walletAddress && (
            <div
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '0.85rem 1rem',
              }}
            >
              <div
                style={{
                  fontSize: '0.64rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--fg-dim)',
                  marginBottom: '0.5rem',
                }}
              >
                Wallet address
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '0.55rem 0.7rem',
                }}
              >
                <code
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: '0.7rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--fg)',
                    wordBreak: 'break-all',
                    lineHeight: 1.4,
                  }}
                >
                  {walletAddress}
                </code>
                <button
                  onClick={copyAddress}
                  style={{
                    flexShrink: 0,
                    background: addressCopied ? 'var(--green-muted)' : 'var(--surface-2)',
                    color: addressCopied ? 'var(--green)' : 'var(--fg)',
                    border: `1px solid ${addressCopied ? 'var(--green-border)' : 'var(--border)'}`,
                    borderRadius: 5,
                    padding: '0.3rem 0.6rem',
                    fontSize: '0.65rem',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {addressCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div
                style={{
                  fontSize: '0.66rem',
                  color: 'var(--fg-dim)',
                  marginTop: '0.45rem',
                  lineHeight: 1.45,
                }}
              >
                Send at least 2 XLM (1 XLM account minimum + 0.5 XLM trustline + 0.5 headroom). To
                receive USDC, the agent must first open a USDC trustline by running{' '}
                <code>cards402 wallet trustline</code>. The stepper will flip to{' '}
                <strong>Funded</strong> automatically once Horizon sees the deposit.
              </div>
            </div>
          )}

          <Button variant="secondary" onClick={onClose} style={{ justifyContent: 'center' }}>
            Close — agent will keep setting up in the background
          </Button>
        </div>
      )}
    </Drawer>
  );
}

const STEP_ORDER: Step[] = ['waiting', 'claimed', 'wallet', 'awaiting_deposit', 'funded', 'active'];

function stepState(currentStep: Step, stepName: Step): 'pending' | 'active' | 'done' {
  const current = STEP_ORDER.indexOf(currentStep);
  const me = STEP_ORDER.indexOf(stepName);
  if (me < current) return 'done';
  if (me === current) return 'active';
  return 'pending';
}

function StepRow({
  state,
  title,
  detail,
}: {
  state: 'pending' | 'active' | 'done';
  title: string;
  detail?: string;
}) {
  const color =
    state === 'done' ? 'var(--green)' : state === 'active' ? 'var(--yellow)' : 'var(--fg-dim)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.55rem',
        padding: '0.4rem 0',
        opacity: state === 'pending' ? 0.5 : 1,
      }}
    >
      <span
        style={{
          marginTop: 5,
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          animation: state === 'active' ? 'pulse 2s ease-in-out infinite' : undefined,
        }}
      />
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: '0.76rem',
            fontFamily: 'var(--font-mono)',
            color,
            fontWeight: state === 'pending' ? 500 : 600,
          }}
        >
          {state === 'done' ? '✓ ' : ''}
          {title}
        </div>
        {detail && (
          <div
            style={{
              color: 'var(--fg-dim)',
              fontSize: '0.68rem',
              marginTop: '0.2rem',
              fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all',
            }}
          >
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}
