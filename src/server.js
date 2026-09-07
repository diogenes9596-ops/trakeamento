require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const pool = require('./db');
const { exigirLogin } = require('./middleware/auth');
const { iniciarJobs } = require('./jobs/pullAdSpend');
const { garantirSecretsIniciais } = require('./services/webhookSecretsService');

const authRoutes = require('./routes/auth');
const adAccountsRoutes = require('./routes/adAccounts');
const dashboardRoutes = require('./routes/dashboard');
const atendentesRoutes = require('./routes/atendentes');
const pixelsRoutes = require('./routes/pixels');
const fxRoutes = require('./routes/fx');
const webhooksConfigRoutes = require('./routes/webhooksConfig');
const eventosManuaisRoutes = require('./routes/eventosManuais');
const webhookDatacrazy = require('./routes/webhookDatacrazy');
const webhookSkale = require('./routes/webhookSkale');
const webhookPayt = require('./routes/webhookPayt');
const brandingRoutes = require('./routes/branding');

const app = express();

// A Railway roda o app atras de um proxy reverso -- sem isso, o Express acha
// que toda requisicao chegou via http (nao https), o que fazia a URL dos
// webhooks aparecer errada ("http://" em vez de "https://") na tela de
// Configuracoes > Webhooks.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'troque_essa_chave',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: false }, // secure:true se usar https direto no app
  })
);

// --- Webhooks (publicos, sem login - sao chamados pelas plataformas externas) ---
app.use('/webhook', webhookDatacrazy);
app.use('/webhook', webhookSkale);
app.use('/webhook', webhookPayt);

// --- Autenticacao ---
app.use('/api/auth', authRoutes);

// --- Marca (logo/nome) -- GET e publico (tela de login), POST exige login internamente ---
app.use('/api/branding', brandingRoutes);

// --- Arquivos publicos (tela de login) ---
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// --- Rotas protegidas (exigem login) ---
app.use('/api/ad-accounts', exigirLogin, adAccountsRoutes);
app.use('/api/dashboard', exigirLogin, dashboardRoutes);
app.use('/api/atendentes', exigirLogin, atendentesRoutes);
app.use('/api/pixels', exigirLogin, pixelsRoutes);
app.use('/api/fx', exigirLogin, fxRoutes);
app.use('/api/webhooks-config', exigirLogin, webhooksConfigRoutes);
app.use('/api/eventos-manuais', exigirLogin, eventosManuaisRoutes);

app.get('/', exigirLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const paginas = ['campanhas', 'criativos', 'leads', 'vendas', 'eventos', 'eventos-manuais', 'configuracoes'];
for (const pagina of paginas) {
  app.get(`/${pagina}`, exigirLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${pagina}.html`));
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  garantirSecretsIniciais().catch((err) => console.error('Erro ao gerar secrets iniciais:', err));
  iniciarJobs();
});
