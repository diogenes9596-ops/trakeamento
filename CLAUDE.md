# CLAUDE.md

Contexto do projeto **Sistema de Rastreamento e Atribuição de Vendas** (painel.semeadoresdigital.com.br) para qualquer sessão do Claude Code que trabalhe neste repositório. Leia isto inteiro antes de mexer em qualquer coisa — várias das regras abaixo já foram quebradas por acidente em sessões anteriores e custaram horas de correção.

---

## Visão geral

Sistema próprio de tracking e atribuição de vendas, construído para substituir uma plataforma de terceiros (semeadores-tracking.vercel.app). Um usuário só (o dono do negócio), login único.

O que o sistema faz, em ordem:
1. Recebe **leads** do WhatsApp/CTWA via webhook do DataCrazy (telefone + `ad_id` + `ctwa_clid` do anúncio que originou o clique).
2. Recebe **vendas** via webhook da Skale Tracking (principal) e da Payt (secundária, hoje sem tráfego).
3. **Atribui**: cruza telefone da venda com telefone do lead recente pra creditar o anúncio certo, sem depender do Gerenciador de Anúncios do Meta.
4. Puxa **gasto** direto da Graph API do Meta (não depende de nenhum evento de conversão pra saber quanto foi gasto).
5. Notifica o **Meta CAPI** (Purchase) quando uma venda da Skale é aprovada, incluindo `ctwa_clid`.
6. Mostra tudo num dashboard: gasto × faturamento × ROAS × CPA, por anúncio/conjunto/campanha/criativo.

```
Anúncio (Meta) --clique--> WhatsApp --DataCrazy--> guarda lead (ad_id + ctwa_clid)
                                                         |
Cliente compra na Skale/Payt --webhook--> guarda venda
                                                         |
                                    motor de atribuição casa telefone
                                    venda <-> lead, credita ad_id
                                                         |
                        Skale: dispara Purchase pro Meta com ctwa_clid
                                                         |
                                    Dashboard: gasto x venda x ROAS
```

---

## Stack

**Atual (usar esta, não trocar sem pedido explícito do usuário):**
- Backend: Node.js + Express
- Banco: PostgreSQL (sem ORM — SQL cru via `pg`, pool em `src/db.js`)
- Frontend: nenhum framework — HTML/JS/CSS servido estaticamente pelo próprio Express (`src/public/`)
- Hospedagem: Railway (projeto `reliable-commitment`, serviço `trakeamento`), auto-deploy a cada push em `main`
- Repositório: GitHub `diogenes9596-ops/trakeamento`
- Integrações externas: Meta Graph API (gasto + estrutura de campanhas + CAPI), Skale Tracking (webhook), Payt (webhook), DataCrazy (webhook)

**Por que não usar ORM/framework de frontend:** decisão original do projeto — simplicidade de deploy e debug em produção via edição direta de arquivo (ver seção "Fluxo de deploy" abaixo). Não introduza Prisma/TypeORM/React/Next sem alinhar antes; isso quebraria todo o fluxo de manutenção já estabelecido.

**Variáveis de ambiente principais:** `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `JANELA_ATRIBUICAO_HORAS` (padrão 72).

---

## Estrutura do repositório

```
src/
  db.js                    # pool de conexão PostgreSQL
  db-migrate.js            # aplica sql/schema.sql + cria usuário admin
  server.js                # Express app
  jobs/
    pullAdSpend.js         # cron a cada 30min: gasto + estrutura + atribuição
  services/
    attributionService.js  # motor de atribuição (telefone -> lead -> ad_id)
    metaAdsService.js       # Graph API: gasto, estrutura, limpeza de campanhas apagadas
    metaCapiService.js      # envio de eventos Lead/Purchase pro Meta CAPI
    fxService.js            # cotação do dólar (cache por dia, ver "Armadilhas")
    webhookSecretsService.js
  routes/
    dashboard.js            # rotas do painel (vendas, campanhas, leads, overview, sincronizar-agora)
    eventosManuais.js       # lançamento manual de venda/lead, envio manual ao CAPI
    webhookSkale.js          # webhook principal de vendas
    webhookPayt.js
    webhookDatacrazy.js
    adAccounts.js, atendentes.js, auth.js, branding.js, fx.js, pixels.js, webhooksConfig.js
sql/
  schema.sql                # schema completo, idempotente (CREATE TABLE IF NOT EXISTS)
```

---

## Modelo de dados

| Tabela | Papel |
|---|---|
| `users` | usuário único de login |
| `webhook_secrets` | secret de cada webhook (`datacrazy`, `payt`, `skale`), editável pelo painel |
| `ad_accounts` | contas de anúncio Meta (BM ID, account ID, token, moeda) |
| `ad_spend_daily` | gasto diário por anúncio, já em BRL. `UNIQUE(ad_id, data)` |
| `fx_rates` | cotação do dólar **fixada por dia** — ver Armadilhas |
| `fx_fallback_config` | modo de fallback da cotação (`automatico` \| `manual`) |
| `leads` | telefone, `ad_id`, `ctwa_clid`, origem, payload bruto |
| `atendentes` | whitelist de e-mails de afiliados autorizados (Payt) |
| `pixels` | pixels do Meta pra CAPI; `is_default=TRUE` é o que recebe os eventos |
| `sales` | **tabela central** — plataforma, `id_externo`, status, telefone, valor, `ad_id`, `lead_id`, `atribuido_em`, `recebido_em`, `payload_bruto`. `UNIQUE(plataforma, id_externo)` |
| `eventos_capi` | log de cada envio ao Meta CAPI (payload + resposta/erro) |
| `meta_campaigns` / `meta_adsets` / `meta_ads` | espelho da estrutura do Meta, `ON DELETE CASCADE` entre os três |
| `produtos_manuais` | produtos pro dropdown de lançamento manual |
| `branding` | white-label (nunca customizado de fato, mas o recurso existe) |

**Sem FK entre `sales`/`ad_spend_daily` e `meta_campaigns`/`meta_ads`** — proposital, guardado só como texto. Isso permite apagar uma campanha que sumiu do Meta sem perder histórico de gasto/atribuição.

O comentário da coluna `sales.status` no `schema.sql` está desatualizado (lista `aguardando`/`reembolsada`). Os valores reais em uso são: `aprovada`, `agendamento`, `desconhecido`, `recusada`, `cancelada` (ver Regras de negócio). Não é `CHECK` constraint — é só `VARCHAR`.

---

## Funcionalidades

- **Contas de anúncio**: cadastro individual ou importação em lote ("Importar BM" — cola token + lista de IDs, sistema resolve nome/moeda).
- **Motor de atribuição**: compara telefone por últimos 9 E últimos 8 dígitos (celular brasileiro às vezes vem com/sem o "9"), dentro de uma janela de `JANELA_ATRIBUICAO_HORAS` (padrão 72h) anterior à venda.
- **Classificação de venda da Skale**: ver Regras de negócio.
- **Meta CAPI**: Skale envia Purchase automático com `ctwa_clid`; Payt/DataCrazy só manual.
- **Limpeza automática de campanhas apagadas**: cron remove do banco campanha/conjunto/anúncio que sumiu de verdade do Meta (não conta pausado).
- **Cotação do dólar fixa por dia**: ver Regras de negócio.
- **Lançamento manual** (`/api/eventos-manuais/lancar-venda`, `/lancar-lead`): herda atribuição automaticamente se o telefone bater.
- **Envio manual ao CAPI** (`/api/eventos-manuais/enviar-vendas-meta`): backfill pontual de Purchase por data.
- **Sincronização sob demanda**: botão "🔄 Sincronizar agora" no painel = `POST /api/dashboard/sincronizar-agora` (mesmo ciclo do cron, na hora).
- **Páginas do painel**: Overview, Campanhas (com drill-down Campanha→Conjunto→Anúncio), Criativos, Leads, Vendas, Eventos (log CAPI), Eventos Manuais, Configurações. **Agendamentos não é página**: é um dos filtros de status dentro de Vendas (`src/public/vendas.html`), junto com Aprovada, Pendente, Recusada e Reembolsada.

---

## Regras de negócio (não quebrar sem pedido explícito do usuário)

1. **"Hoje" = data real do pagamento** (`paid_at_data` da Skale), nunca a data de criação do pedido nem a hora que o webhook chegou. Sempre ancorado em `-03:00` (Brasília) — nunca deixe uma data sem timezone explícito nesse fluxo.
2. **Classificação de status da Skale** — usa campos específicos do payload, nunca busca cega:
   - `payment_method="After Pay"` + não pago → `agendamento`
   - qualquer pedido com `payment_status="Pago"` → `aprovada`
   - Antecipada aguardando confirmação → `desconhecido` (aba "Pendente", não conta como venda nem agendamento)
   - recusado → `recusada`; cancelado/estornado/chargeback → `cancelada`
3. **Meta CAPI da Skale: automático desde 15/09/2026.** Ao aprovar uma venda, busca o `ctwa_clid` do lead já casado na atribuição e manda Purchase com telefone (hash) + `ctwa_clid`. **Payt e DataCrazy continuam manuais** — não ligue o automático neles sem pedido explícito (já rolou um incidente de CAPI automático "vazando" nesses dois sem ninguém perceber; ver Armadilhas).
4. **Cotação do dólar fixa por dia, nunca recalculada depois de definida.** Cada dia trava seu próprio valor na primeira vez que é consultado.
5. **Campanha/conjunto/anúncio apagado de verdade no Meta some do painel automaticamente; pausado continua aparecendo.**
6. **Vendas de afiliado da Payt fora da whitelist de `atendentes` são ignoradas** pelo webhook.
7. **Lançamento manual de venda deve sempre usar o `id_externo` real da Skale** (`ven_XXXXXX`, `plataforma='skale'`) quando o pedido existir lá — nunca inventar um ID (`manual_...`). Isso já causou dezenas de duplicatas quando o webhook real chegava depois com um ID diferente do que foi inventado.
8. **Login único** — tokens do Meta e dos pixels nunca aparecem completos na UI.

---

## Fluxo de deploy (sem terminal Git local neste ambiente)

1. Buscar o conteúdo atual do arquivo **via API do GitHub** (`api.github.com/repos/diogenes9596-ops/trakeamento/contents/<path>`) — **nunca** via `raw.githubusercontent.com`, que tem cache de CDN e já causou sobrescrita de correção com conteúdo desatualizado.
2. Editar via `document.execCommand('insertText')` no editor web do GitHub, depois de `selectAll`.
3. Commitar pela interface web do GitHub.
4. Aguardar o deploy automático no Railway (10–30s).
5. Confirmar "ACTIVE"/"Deployment successful" no Railway antes de considerar concluído.
6. Reler o arquivo pela API do GitHub de novo pra confirmar o resultado final — nunca confiar em cópia local.

---

## Armadilhas conhecidas (gotchas)

- **Não confie em cópias locais do código numa sessão longa.** Em pelo menos duas ocasiões um arquivo local ficou corrompido (import duplicado, rota truncada) sem nenhuma ação explícita que explicasse — o código publicado nunca foi afetado, mas o hábito seguro é sempre reconferir via API do GitHub antes de editar.
- **Telefone brasileiro**: sempre comparar por últimos 9 E últimos 8 dígitos. Uma fonte pode mandar com o "9" do celular, outra sem.
- **Datas sem hora exata**: nunca faça fallback pra meia-noite sem `-03:00` explícito — isso já quebrou tanto a atribuição (lead parecia vir "depois" da venda) quanto a data de exibição no painel (venda caindo no dia errado dependendo do fuso da comparação).
- **`fx_rates` pode ficar vazia mesmo com a função de salvar existindo** — `salvarCotacaoDoDia` só é chamada pela rota manual `/api/fx/dia`; a função de leitura (`obterCotacaoParaData`) precisa *também* chamar o save após buscar ao vivo, senão a "cotação do dia" nunca fica fixa de verdade (bug real, já corrigido, mas fique atento se reaparecer numa refatoração).
- **CAPI automático "vazando"**: ao ligar/desligar envio automático numa integração (Skale/Payt/DataCrazy), sempre confira as outras duas também — elas não sincronizam sozinhas, e um webhook pode continuar mandando eventos automáticos que você achava que tinha desligado globalmente.
- **`UNIQUE(plataforma, id_externo)` é o que evita duplicata** — qualquer lançamento manual ou correção que não preencha esses dois campos com o valor real da plataforma de origem é candidato a duplicar quando o webhook de verdade chegar.
- **Duplicatas por telefone não são sempre erro**: um mesmo cliente pode ter duas compras reais e distintas com valores diferentes no mesmo telefone — nunca deduplicar só por telefone batendo, sempre confirmar por `id_externo`/valor antes de apagar algo.

---

## Convenções de código

- Comentários e nomes de variáveis/rotas do domínio de negócio em **português** (`recebido_em`, `atribuido_em`, `nome_cliente`); nomes de infraestrutura genérica em inglês (`pool`, `router`, `req`, `res`).
- SQL cru com placeholders (`$1`, `$2`...), sem query builder.
- `console.log`/`console.error` em português, descritivos — são a única forma de debug em produção (não há APM configurado); logar o payload bruto completo em webhooks é intencional, não remover.
- `schema.sql` é sempre idempotente (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`) — nunca reescrever uma tabela existente com `DROP`.
