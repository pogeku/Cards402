// Developer page — webhook delivery log, test-webhook form, code
// snippets. Everything an integrator needs to verify their webhook
// endpoint works before an agent goes live.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '../_ui/Card';
import { Button } from '../_ui/Button';
import { Input } from '../_ui/Input';
import { Pill } from '../_ui/Pill';
import { Drawer } from '../_ui/Drawer';
import { EmptyState } from '../_ui/EmptyState';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { useToast } from '../_ui/Toast';
import { fetchWebhookDeliveries, sendTestWebhook } from '../_lib/api';
import type { WebhookDelivery } from '../_lib/types';
import { timeAgo } from '../_lib/format';

export default function DeveloperPage() {
  const toast = useToast();
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [selected, setSelected] = useState<WebhookDelivery | null>(null);
  const [testUrl, setTestUrl] = useState('');
  const [testSecret, setTestSecret] = useState('');
  const [testing, setTesting] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { deliveries } = await fetchWebhookDeliveries(50);
      setDeliveries(deliveries);
    } catch (err) {
      toast.push((err as Error).message || 'failed to load deliveries', 'error');
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function runTest() {
    if (!testUrl.trim()) return;
    setTesting(true);
    try {
      const result = await sendTestWebhook({
        url: testUrl.trim(),
        webhook_secret: testSecret.trim() || undefined,
      });
      toast.push(result.note || 'Test delivered', 'success');
      await reload();
    } catch (err) {
      toast.push((err as Error).message || 'delivery failed', 'error');
    } finally {
      setTesting(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Developer"
        subtitle="Webhook delivery log, send a test webhook, and grab integration snippets."
      />

      <Card title="Send a test webhook">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
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
              Webhook URL
            </div>
            <Input
              placeholder="https://your-service.example/webhook"
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
            />
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
              Signing secret (optional)
            </div>
            <Input
              placeholder="whsec_…"
              value={testSecret}
              onChange={(e) => setTestSecret(e.target.value)}
              type="password"
            />
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--fg-dim)', lineHeight: 1.5 }}>
            We'll POST a sample <code>delivered</code> payload with fake card data. If you pass a
            secret, we'll sign it with <code>X-Cards402-Signature: sha256=hex(HMAC(ts.body))</code>{' '}
            and <code>X-Cards402-Timestamp</code>.
          </div>
          <Button
            variant="primary"
            onClick={runTest}
            disabled={testing || !testUrl.trim()}
            style={{ alignSelf: 'flex-start' }}
          >
            {testing ? 'Sending…' : 'Send test webhook'}
          </Button>
        </div>
      </Card>

      <Card title="Recent deliveries" padding={0}>
        {deliveries === null ? (
          <EmptyState title="Loading…" />
        ) : deliveries.length === 0 ? (
          <EmptyState
            title="No deliveries yet"
            description="Every outbound webhook — order lifecycle callbacks, tests, retries — will show up here."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>URL</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Latency</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} onClick={() => setSelected(d)} style={{ cursor: 'pointer' }}>
                  <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>
                    {timeAgo(d.created_at)}
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      maxWidth: 420,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.url}
                  </td>
                  <td>
                    {d.response_status && d.response_status < 400 ? (
                      <Pill tone="green">{d.response_status}</Pill>
                    ) : d.response_status ? (
                      <Pill tone="red">{d.response_status}</Pill>
                    ) : (
                      <Pill tone="red">{d.error || 'failed'}</Pill>
                    )}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.72rem',
                      color: 'var(--fg-dim)',
                    }}
                  >
                    {d.latency_ms !== null ? `${d.latency_ms}ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Integration snippets">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <div
            style={{
              fontSize: '0.78rem',
              color: 'var(--fg-muted)',
              lineHeight: 1.55,
            }}
          >
            The <code>cards402</code> npm package ships a CLI for onboarding and a TypeScript SDK
            for purchases. See{' '}
            <a
              href="https://cards402.com/docs"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--green)', textDecoration: 'none' }}
            >
              docs
            </a>{' '}
            for the full reference.
          </div>
          <Snippet title="Install" code={`npm install cards402`} />
          <Snippet title="Onboard an agent" code={`npx cards402 onboard --claim <claim-code>`} />
          <Snippet
            title="Purchase a card"
            code={`import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  amountUsdc: '10.00',
  paymentAsset: 'xlm',
  walletName: 'my-agent',
});`}
          />
          <Snippet
            title="Verify a webhook signature (Node)"
            code={`import crypto from 'node:crypto';

function verify(req, secret) {
  const ts = req.headers['x-cards402-timestamp'];
  const sig = req.headers['x-cards402-signature']?.replace('sha256=', '');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(\`\${ts}.\${req.rawBody}\`)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(sig, 'hex'),
    Buffer.from(expected, 'hex')
  );
}`}
          />
        </div>
      </Card>

      {selected && (
        <Drawer open={true} onClose={() => setSelected(null)} title="Delivery detail" width={540}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <DetailRow label="URL">
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.72rem',
                  wordBreak: 'break-all',
                }}
              >
                {selected.url}
              </span>
            </DetailRow>
            <DetailRow label="Status">
              {selected.response_status ? (
                <Pill tone={selected.response_status < 400 ? 'green' : 'red'}>
                  HTTP {selected.response_status}
                </Pill>
              ) : (
                <Pill tone="red">{selected.error || 'failed'}</Pill>
              )}
            </DetailRow>
            <DetailRow label="Latency">
              {selected.latency_ms !== null ? `${selected.latency_ms}ms` : '—'}
            </DetailRow>
            {selected.signature && (
              <DetailRow label="Signature">
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.7rem',
                    wordBreak: 'break-all',
                  }}
                >
                  {selected.signature}
                </span>
              </DetailRow>
            )}
            <CodeBlock
              title="Request body"
              content={
                typeof selected.request_body === 'string'
                  ? selected.request_body
                  : JSON.stringify(selected.request_body, null, 2)
              }
            />
            {selected.response_body && (
              <CodeBlock title="Response body" content={selected.response_body} />
            )}
          </div>
        </Drawer>
      )}
    </PageContainer>
  );
}

function Snippet({ title, code }: { title: string; code: string }) {
  const toast = useToast();
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.35rem',
        }}
      >
        <div
          style={{
            fontSize: '0.66rem',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--fg-dim)',
          }}
        >
          {title}
        </div>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            toast.push('Copied', 'success');
          }}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--fg-dim)',
            fontSize: '0.66rem',
            padding: '0.15rem 0.5rem',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Copy
        </button>
      </div>
      <pre
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '0.75rem 1rem',
          margin: 0,
          fontSize: '0.72rem',
          fontFamily: 'var(--font-mono)',
          overflow: 'auto',
          lineHeight: 1.5,
          color: 'var(--fg)',
        }}
      >
        {code}
      </pre>
    </div>
  );
}

function CodeBlock({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: '0.62rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--fg-dim)',
          marginBottom: '0.35rem',
        }}
      >
        {title}
      </div>
      <pre
        style={{
          fontSize: '0.7rem',
          margin: 0,
          background: 'var(--surface-2)',
          padding: '0.75rem 0.85rem',
          borderRadius: 8,
          border: '1px solid var(--border)',
          maxHeight: 280,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {content}
      </pre>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          fontSize: '0.62rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--fg-dim)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--fg)' }}>{children}</div>
    </div>
  );
}
