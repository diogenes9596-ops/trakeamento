-- ============================================================
-- Sistema de Rastreamento / Atribuição de Vendas — v2
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Secrets dos webhooks, editáveis pelo painel (sem precisar mexer na hospedagem)
CREATE TABLE IF NOT EXISTS webhook_secrets (
    id SERIAL PRIMARY KEY,
    servico VARCHAR(30) UNIQUE NOT NULL, -- 'datacrazy', 'payt', 'skale'
    secret VARCHAR(128) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contas de anúncio cadastradas (BM ID + token)
CREATE TABLE IF NOT EXISTS ad_accounts (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    business_manager_id VARCHAR(100) NOT NULL,
    ad_account_id VARCHAR(100) NOT NULL, -- ex: act_1234567890
    access_token TEXT NOT NULL,
    moeda VARCHAR(5) DEFAULT 'BRL',
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Gasto diário por anúncio (puxado da Graph API do Meta), já convertido pra BRL
CREATE TABLE IF NOT EXISTS ad_spend_daily (
    id SERIAL PRIMARY KEY,
    ad_account_id INTEGER REFERENCES ad_accounts(id) ON DELETE CASCADE,
    ad_id VARCHAR(100) NOT NULL,
    ad_name VARCHAR(500),
    adset_id VARCHAR(100),
    adset_name VARCHAR(500),
    campaign_id VARCHAR(100),
    campaign_name VARCHAR(500),
    data DATE NOT NULL,
    gasto_moeda_original NUMERIC(12,2) NOT NULL DEFAULT 0,
    moeda_original VARCHAR(5) DEFAULT 'BRL',
    gasto NUMERIC(12,2) NOT NULL DEFAULT 0, -- sempre em BRL
    impressoes INTEGER DEFAULT 0,
    cliques INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ad_id, data)
);

-- Cotação do dólar por dia (usada pra converter contas de anúncio em USD)
CREATE TABLE IF NOT EXISTS fx_rates (
    id SERIAL PRIMARY KEY,
    data DATE UNIQUE NOT NULL,
    cotacao NUMERIC(10,4) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Configuração de fallback (quando não tem cotação daquele dia especificamente)
CREATE TABLE IF NOT EXISTS fx_fallback_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    modo VARCHAR(10) NOT NULL DEFAULT 'automatico', -- 'automatico' | 'manual'
    valor_manual NUMERIC(10,4),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (id = 1)
);
INSERT INTO fx_fallback_config (id, modo) VALUES (1, 'automatico') ON CONFLICT (id) DO NOTHING;

-- Leads recebidos via webhook do DataCrazy (WhatsApp / CTWA)
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    telefone VARCHAR(30) NOT NULL, -- normalizado, só dígitos
    nome VARCHAR(255),
    origem VARCHAR(50) NOT NULL DEFAULT 'ctwa_whatsapp',
    ad_id VARCHAR(100),        -- vem de "source_id"
    ctwa_clid VARCHAR(255),
    source_url VARCHAR(500),
    page_id VARCHAR(100),
    payload_bruto JSONB,
    recebido_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_telefone ON leads(telefone);
CREATE INDEX IF NOT EXISTS idx_leads_recebido_em ON leads(recebido_em);

-- Afiliados autorizados (whitelist) — vendas da Payt de afiliados fora
-- dessa lista são ignoradas pelo webhook
CREATE TABLE IF NOT EXISTS atendentes (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    nome VARCHAR(255),
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pixels do Meta cadastrados, usados pra reenviar eventos via CAPI
CREATE TABLE IF NOT EXISTS pixels (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    pixel_id VARCHAR(100) NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    eventos_capi VARCHAR(30) NOT NULL DEFAULT 'venda', -- 'venda' | 'venda_agendamento'
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vendas recebidas via webhook (Skale, PayT)
CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
    plataforma VARCHAR(50) NOT NULL, -- 'skale', 'payt'
    id_externo VARCHAR(255),
    status VARCHAR(50) NOT NULL, -- 'aprovada' | 'cancelada' | 'aguardando' | 'agendamento' | 'reembolsada' | 'recusada'
    telefone VARCHAR(30),
    email VARCHAR(255),
    nome_cliente VARCHAR(255),
    valor NUMERIC(12,2) NOT NULL DEFAULT 0,
    produto VARCHAR(255),
    afiliado_email VARCHAR(255),
    payload_bruto JSONB,
    -- atribuição (preenchido pelo motor de atribuição)
    ad_id VARCHAR(100),
    lead_id INTEGER REFERENCES leads(id),
    atribuido_em TIMESTAMPTZ,
    recebido_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (plataforma, id_externo)
);
CREATE INDEX IF NOT EXISTS idx_sales_telefone ON sales(telefone);
CREATE INDEX IF NOT EXISTS idx_sales_ad_id ON sales(ad_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);

-- Log de eventos enviados pro Meta via Conversions API (Lead / Purchase)
CREATE TABLE IF NOT EXISTS eventos_capi (
    id SERIAL PRIMARY KEY,
    evento VARCHAR(30) NOT NULL, -- 'Lead' | 'Purchase'
    telefone VARCHAR(30),
    pixel_id VARCHAR(100),
    status VARCHAR(20) NOT NULL, -- 'ok' | 'erro'
    payload JSONB,
    erro_mensagem TEXT,
    enviado_em TIMESTAMPTZ DEFAULT NOW()
);
