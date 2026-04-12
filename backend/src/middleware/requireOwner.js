// @ts-check
// Middleware: requires req.user.role === 'owner'.
// Must be used after requireAuth.
// Applied to destructive admin operations that only owners should perform.

module.exports = function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (req.user.role !== 'owner') {
    return res
      .status(403)
      .json({ error: 'owner_only', message: 'This action requires owner access.' });
  }
  next();
};
