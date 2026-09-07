function exigirLogin(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ erro: 'Nao autenticado' });
  }
  return res.redirect('/login.html');
}

module.exports = { exigirLogin };
