// Thin wrapper around Pill that does the order-status lookup so every
// page gets consistent labels + tones + pulse state.

import { Pill } from './Pill';
import { ORDER_STATUS_PULSING, getOrderStatusLabel, getOrderStatusTone } from '../_lib/constants';

export function OrderStatusPill({ status }: { status: string }) {
  return (
    <Pill tone={getOrderStatusTone(status)} pulse={ORDER_STATUS_PULSING.has(status)}>
      {getOrderStatusLabel(status)}
    </Pill>
  );
}
