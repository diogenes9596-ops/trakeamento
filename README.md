# Sistema de Rastreamento e Atribuição de Vendas

Sistema próprio (só seu — ninguém mais vê seus dados), construído pra reproduzir
a plataforma de tracking que você já usa. Cobre:

1. **Contas de anúncio** — puxa gasto direto da API do Meta (BM ID + token),
   com importação em massa (cola o token + lista de account IDs e o sistema
   resolve nome/moeda de cada uma) ou cadastro manual, um por vez.
2. **Leads via DataCrazy (WhatsApp / CTWA)** — recebe webhook com telefone,
   `ctwa_clid` e `source_id` (o anúncio) toda vez que alguém clica num anúncio
   e cai no WhatsApp.
3. **Vendas via Payt e Skale Tracking** — a Skale funciona no modelo
   *Pay After Delivery*: primeiro vira **agendamento**, e só quando o
   pagamento confirma (depois da entrega) é que vira **venda** de verdade.
4. **Atendentes** — lista de e-mails de afiliados autorizados; vendas da Payt
   de afiliados fora da lista são ignoradas.
5. **Atribuição** — casa telefone da venda com telefone do lead (numa janela
   de tempo configurável) e credita o anúncio certo, sem depender do
   gerenciador de anúncios.
6. **Pixels + Conversions API (CAPI)** — reenvia os eventos de Lead e Purchase
   pro Meta do lado do servidor, deduplicado com o pixel do navegador, pra
   melhorar a otimização dos anúncios.
7. **Cotação do dólar** — converte automaticamente o gasto de contas em USD
   pra BRL, com cotação por dia ou fallback (automático via API, ou manual).
8. **Dashboard completo**: Overview, Campanhas (Campanhas/Conjuntos/Anúncios),
   Criativos (ranking agrupado por nome do criativo), Leads, Vendas, Eventos
   (log do CAPI) e Configurações.

---

## 1. Visão geral da arquitetura

```
Anúncio (Meta) --clique--> WhatsApp --DataCrazy--> [seu sistema] guarda o lead com o ad_id (source_id)
                                                        |
Cliente compra na Skale/Payt --webhook-->  [seu sistema] guarda a venda
                                                        |
                                          motor de atribuição casa telefone
                                          venda <-> lead e credita o ad_id
                                                        |
                                    [seu sistema] reenvia Lead/Purchase pro Meta via CAPI
                                                        |
                                    Dashboard: gasto x venda x ROAS x lucro
```

O gasto vem direto da API do Meta — a atribuição não depende do gerenciador
"marcar certo" a venda, porque o cruzamento é feito por telefone, por conta
própria.

---

## 2. O que você precisa antes de colocar no ar

- **Hospedagem** com Node.js (Railway, Render, ou uma VPS). Recomendo
  **Railway** por ser o mais simples pra quem não mexe com servidor.
- **PostgreSQL** (Railway/Render oferecem com um clique).
- **Domínio com HTTPS** apontando pra hospedagem (a Meta e o DataCrazy
  exigem HTTPS nos webhooks).
- **Token de acesso do Meta Ads** (Business Manager > Usuários do Sistema).
- **Conta no DataCrazy** já conectada aos seus números de WhatsApp.
- **Acesso ao painel da Payt e da Skale Tracking** pra cadastrar as URLs de
  webhook.

---

## 3. Passo a passo de instalação

### 3.1. Local (opcional, pra testar antes)

```bash
npm install
cp .env.example .env
# edite o .env com ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, etc.
npm run migrate   # cria as tabelas, o usuario admin, e gera os secrets dos webhooks
npm start
```

Acesse `http://localhost:3000` e faça login com o `ADMIN_EMAIL`/`ADMIN_PASSWORD`
que você definiu no `.env`.

### 3.2. Subindo em hospedagem (exemplo com Railway)

1. Crie uma conta em [railway.app](https://railway.app).
2. Novo projeto → suba este código (via GitHub ou Railway CLI).
3. Adicione um serviço **PostgreSQL** no mesmo projeto (gera a `DATABASE_URL`
   automaticamente).
4. Configure as variáveis de ambiente (`ADMIN_EMAIL`, `ADMIN_PASSWORD`,
   `SESSION_SECRET`, `DATABASE_URL`, etc. — veja `.env.example`).
5. Rode `npm run migrate` uma vez (cria tabelas + usuário + secrets).
6. Railway já entrega HTTPS automático com um domínio tipo
   `seuapp.up.railway.app`.

---

## 4. Configurando cada integração

Depois de logado, vá em **Configurações** — lá tem uma aba **"Webhooks"** que
já mostra a URL completa e o secret atual de cada integração (copia e cola
direto de lá, sem precisar decorar nada). Você pode gerar um novo secret a
qualquer momento, direto pelo painel, sem precisar reiniciar o servidor.

### 4.1. Contas de anúncio

Em **Configurações > Contas de anúncio**, use **"Importar BM"**: cola o
BM ID, o token, e a lista de account IDs (separados por vírgula ou quebra de
linha). O sistema busca o nome e a moeda de cada conta no Meta, você confirma
quais quer cadastrar, e pronto.

### 4.2. DataCrazy (leads via WhatsApp)

No painel do DataCrazy, cadastre um webhook de saída apontando pra:
`https://SEU_DOMINIO/webhook/datacrazy`, com o header `x-datacrazy-secret`
preenchido com o secret que aparece em Configurações > Webhooks.

### 4.3. Payt

No painel da Payt, em Ofertas & Produtos > Postbacks, cadastre a URL que
aparece em Configurações > Webhooks (já vem com o `?token=` incluído).

### 4.4. Skale Tracking

Mesma ideia: cola a URL de Configurações > Webhooks no painel da Skale.

**Importante:** o formato exato de alguns campos (principalmente o array de
`commission` da Payt, que define o valor líquido do produtor) foi montado com
base na documentação disponível publicamente. O sistema **loga o payload
completo no console** a cada venda recebida — assim que você fizer a primeira
venda de teste, me manda esse log (tira token/dado sensível) que eu ajusto o
parser pra bater exatamente. É rápido.

### 4.5. Pixels (Conversions API)

Em Configurações > Pixels, cadastre o Pixel ID + token de acesso do sistema
(gerado no Gerenciador de Eventos do Meta). Escolha se aquele pixel recebe só
eventos de **Venda** (Purchase) ou **Venda + Agendamento** (Purchase + Lead).

---

## 5. Como a atribuição funciona por baixo dos panos

- Lead chega via DataCrazy → salvamos telefone + `ad_id` (vindo de `source_id`).
- Venda chega (Payt/Skale) → procuramos, nos leads dos últimos
  **72 horas** (ajustável em `JANELA_ATRIBUICAO_HORAS` no `.env`), aquele
  telefone que bate (comparando só os últimos dígitos, pra não dar problema
  de formatação).
- Se achar, credita o `ad_id` daquele lead na venda (aparece como "MATCH" na
  aba Vendas).
- Se não achar, fica "sem atribuição" (pode ser orgânico, indicação, etc.).
- Roda automaticamente a cada 30 minutos, ou na hora, a cada webhook de
  venda recebido.

## 6. Regra especial da Skale (Pay After Delivery)

- Pedido criado com pagamento **"After Pay"** e ainda não pago → vira
  **agendamento** (fica atribuído por telefone, mas não conta como venda
  nem dispara Purchase pro Meta ainda).
- Quando o pagamento confirma depois (entrega + cobrança realizada) → vira
  **venda de verdade**, e aí sim dispara o evento Purchase.

---

## 7. Segurança

- Só existe **um usuário** (você).
- Tokens do Meta e dos pixels nunca aparecem completos na tela.
- Os secrets dos webhooks ficam no banco, editáveis só por você logado.
- Vendas de afiliados fora da lista de Atendentes são automaticamente
  ignoradas pelo webhook da Payt.

---

## 8. Próximos ajustes possíveis

- Calibrar o parser da Payt com um payload real de teste (campo `commission`).
- Resolver nome de campanha/conjunto/anúncio automaticamente via Graph API
  quando um `source_id` novo aparece num lead (hoje o nome só aparece depois
  que aquele anúncio já teve gasto sincronizado).
- Exportação de relatórios em CSV/Excel.
- Alertas automáticos (ex: avisar no WhatsApp quando o ROAS cair abaixo de X).
