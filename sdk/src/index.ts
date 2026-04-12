export { Cards402Client } from './client';
export type {
  OrderOptions,
  OrderResponse,
  OrderStatus,
  OrderListItem,
  OrderPhase,
  CardDetails,
  PaymentInstructions,
  Budget,
  UsageSummary,
} from './client';

export {
  createWallet,
  getBalance,
  addUsdcTrustline,
  payViaContract,
  purchaseCard,
  // Back-compat alias for payViaContract.
  payVCC,
} from './stellar';
export type { WalletInfo, PayOpts } from './stellar';

export {
  createOWSWallet,
  importStellarKey,
  getOWSPublicKey,
  getOWSBalance,
  addUsdcTrustlineOWS,
  payViaContractOWS,
  purchaseCardOWS,
  // Back-compat alias.
  payVCCOWS,
} from './ows';
export type {
  TrustlineOpts,
  PayViaContractOwsOpts,
  PayVCCOwsOpts,
  PurchaseCardOwsOpts,
} from './ows';

export {
  Cards402Error,
  SpendLimitError,
  RateLimitError,
  ServiceUnavailableError,
  PriceUnavailableError,
  InvalidAmountError,
  AuthError,
  OrderFailedError,
  WaitTimeoutError,
} from './errors';
