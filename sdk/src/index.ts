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
  checkSorobanTxLanded,
  payViaContractOWS,
  purchaseCardOWS,
  onboardAgent,
  // Back-compat alias.
  payVCCOWS,
} from './ows';
export type {
  TrustlineOpts,
  PayViaContractOwsOpts,
  PayVCCOwsOpts,
  PurchaseCardOwsOpts,
  OnboardAgentOpts,
  OnboardAgentResult,
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
  ResumableError,
} from './errors';

export { loadCards402Config, saveCards402Config, resolveCredentials } from './config';
export type { Cards402Config } from './config';
