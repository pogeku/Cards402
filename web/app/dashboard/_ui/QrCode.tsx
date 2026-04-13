// Tiny QR code renderer. We don't want a full qrcode library for this,
// so Phase 1 falls back to a public QR image endpoint with a cached
// query string. Swapping to an in-process renderer is a later concern.

interface Props {
  text: string;
  size?: number;
}

export function QrCode({ text, size = 220 }: Props) {
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(
    text,
  )}`;
  return (
    <div
      style={{
        width: size,
        height: size,
        background: '#fff',
        borderRadius: 8,
        padding: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Plain <img> on purpose: the QR endpoint returns a one-off
          PNG that we don't want to route through Next's image
          optimiser (it would add caching pressure and give us nothing
          in return for a static-per-address artwork). */}
      <img src={src} alt="QR code" width={size - 12} height={size - 12} />
    </div>
  );
}
