require('dotenv').config();
require('./env');

const app = require('./app');
const { startJobs } = require('./jobs');
const { startWatcher } = require('./payments/stellar');
const { handlePayment } = require('./payment-handler');

startJobs();

startWatcher(handlePayment);

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(
    `[cards402] backend running on port ${PORT} (${process.env.NODE_ENV || 'development'})`,
  );
});

process.on('SIGTERM', () => {
  console.log('[cards402] SIGTERM — shutting down gracefully');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
});
