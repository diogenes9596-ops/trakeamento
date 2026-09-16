# Sistema de Rastreamento e Atribuição de Vendas

Sistema próprio (só seu — ninguém mais vê seus dados), construído pra substituir
a plataforma de tracking de terceiros que você usava. Cobre:

1. **Contas de anúncio** — puxa gasto direto da Graph API do Meta (BM ID +
   token), com importação em massa ("Importar BM": cola o token + a lista de
   account IDs e o sistema resolve nome/moeda de cada uma) ou cadastro manual.
2. **Leads via DataCrazy (WhatsApp / CTWA)** — recebe webhook com telefone,
   `ctwa_clid` e `source_id` (o anúncio) toda vez que alguém clica num anúncio
   e cai no WhatsApp.
3. **Vendas via Skale Tracking e Payt** — a Skale é a origem principal e
   funciona no modelo *Pay After Delivery*; a Payt é secundária.
4. **Atendentes** — lista de e-mails de afiliados autorizados; vendas da Payt
   de afiliados fora da lista são ignoradas.
5. **Atribuição** — casa o telefone da venda com o telefone do lead, numa
   janela de tempo configurável, e credita o anúncio certo, sem depender do
   Gerenciador de Anúncios.
6. **Meta CAPI (Conversions API)** — **nenhuma integração envia evento
   automático** (nem Skale, nem Payt, nem DataCrazy), e lançar venda manual
   também não envia. O único envio é o botão **Enviar ao Meta**, na página
   Eventos Manuais. Veja a seção 7.
7. **Cotação do dólar** — converte o gasto de contas em USD pra BRL, com a
   cotação travada por dia.
8. **Dashboard**: Overview, Campanhas (Campanhas → Conjuntos → Anúncios),
   Criativos, Leads, Vendas, Eventos (log do CAPI), Eventos Manuais e
   Configurações.

---

## 1. Visão geral da arquitetura

```
Anúncio (Meta) --clique--> WhatsApp --DataCrazy--> guarda o lead (ad_id vem do source_id, + ctwa_clid)
                                                        |
Cliente compra na Skale/Payt --webhook--> guarda a venda
                                                        |
                                          motor de atribuição casa telefone
                                          venda <-> lead e credita o ad_id
                                                        |
                   envio MANUAL (Eventos Manuais): Purchase pro Meta com ctwa_clid
                                                        |
                                    Dashboard: gasto x faturamento x ROAS x CPA
```

O gasto vem direto da API do Meta — a atribuição não depende do Gerenciador
"marcar certo" a venda, porque o cruzamento é feito por telefone, por conta
própria.

---

## 2. O que você precisa antes de colocar no ar

- **Hospedagem** com Node.js. A produção hoje roda na **Railway**.
- **PostgreSQL** (a Railway oferece com um clique).
- **Domínio com HTTPS** apontando pra hospedagem (a Meta e o DataCrazy exigem
  HTTPS nos webhooks).
- **Token de acesso do Meta Ads** (Business Manager > Usuários do Sistema).
- **Conta no DataCrazy** já conectada aos seus números de WhatsApp.
- **Acesso ao painel da Skale Tracking e da Payt** pra cadastrar as URLs de
  webhook.

---

## 3. Passo a passo de instalação

### 3.1. Local (opcional, pra testar antes)

```bash
npm install
cp .env.example .env
# edite o .env com ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, etc.
npm run migrate   # aplica o schema, cria o usuário admin e gera os secrets dos webhooks
npm start
```

Acesse `http://localhost:3000` e faça login com o `ADMIN_EMAIL`/`ADMIN_PASSWORD`
que você definiu no `.env`.

`npm run migrate` é idempotente: pode rodar de novo sem apagar nada.

### 3.2. Subindo em hospedagem (Railway)

1. Novo projeto → suba este código (via GitHub ou Railway CLI).
2. Adicione um serviço **PostgreSQL** no mesmo projeto (gera a `DATABASE_URL`).
3. Configure as variáveis de ambiente (`DATABASE_URL`, `ADMIN_EMAIL`,
   `ADMIN_PASSWORD`, `SESSION_SECRET`, `JANELA_ATRIBUICAO_HORAS` — veja o
   `.env.example`).
4. Rode `npm run migrate` uma vez.
5. A Railway já entrega HTTPS automático.

O fluxo de manutenção da produção (deploy, cuidados, armadilhas conhecidas)
está no `CLAUDE.md`, que é a referência que vale em caso de divergência com
este README.

---

## 4. Configurando cada integração

Depois de logado, vá em **Configurações > Webhooks**: lá aparece a URL completa
e o secret atual de cada integração, prontos pra copiar. Você pode gerar um
secret novo a qualquer momento pelo painel, sem reiniciar o servidor.

### 4.1. Contas de anúncio

Em **Configurações > Contas de anúncio**, use **"Importar BM"**: cola o BM ID,
o token e a lista de account IDs (separados por vírgula ou quebra de linha). O
sistema busca nome e moeda de cada conta no Meta, você confirma quais quer
cadastrar, e pronto.

### 4.2. DataCrazy (leads via WhatsApp)

No painel do DataCrazy, cadastre um webhook de saída apontando pra
`https://SEU_DOMINIO/webhook/datacrazy`, com o header `x-datacrazy-secret`
preenchido com o secret que aparece em Configurações > Webhooks.

O sistema procura `phone`, `ctwa_clid`, `source_id`, `source_url` e `page_id`
tanto na raiz do payload quanto em `referral`, `message.referral` e `metadata`.
Sem `phone`, o evento é ignorado. **Esse webhook só registra o lead — não
dispara nenhum evento pro Meta.**

### 4.3. Skale Tracking (vendas — origem principal)

Cole no painel da Skale a URL que aparece em Configurações > Webhooks (já vem
com o `?token=`). A autenticação aceita o token na query string ou o header
`x-skale-secret`.

A Skale manda um evento `order_updated` a cada mudança de status do pedido.
Campos lidos (confirmados com payloads reais):

| Campo no payload | Vira |
|---|---|
| `transaction_id` (formato `ven_XXXXXX`) | ID do pedido — chave contra duplicata |
| `customer.phone` / `customer.name` / `customer.email` | telefone / nome / e-mail |
| `product.name` | produto (nome do kit, ex: "6 MESES") |
| `transaction.total_price` | valor — **sempre em centavos**, dividido por 100 |

O valor é o bruto do pedido, sem descontar taxa ou comissão — a mesma régua do
"Faturamento" da própria Skale. Se um evento chegar sem `total_price` (ex:
atualização tardia de rastreio), a venda **mantém o valor que já tinha**.

### 4.4. Payt (vendas — secundária)

No painel da Payt, em Ofertas & Produtos > Postbacks, cadastre a URL que
aparece em Configurações > Webhooks (já vem com o `?token=`).

O valor considerado é o líquido do produtor, lido do array `commission` do
payload. **Esse trecho foi montado com base na documentação pública da Payt e
ainda não foi validado com um payload real.** Todo webhook loga o payload
completo no console (isso é intencional, é a forma de debug em produção) — na
primeira venda real dá pra conferir os nomes dos campos e ajustar o parser.

### 4.5. Pixels (Conversions API)

Em Configurações > Pixels, cadastre o Pixel ID + o token de acesso gerado no
Gerenciador de Eventos do Meta. O pixel marcado como **padrão** (`is_default`)
é o que recebe os eventos.

Cada pixel tem uma opção de quais eventos recebe: só **Venda** (Purchase) ou
**Venda + Agendamento** (Purchase + Lead). Na prática, hoje **nenhum fluxo do
sistema dispara evento de Lead** — nem automático, nem manual —, então essa
opção não muda nada por enquanto: o que sai daqui é sempre Purchase.

---

## 5. Como a atribuição funciona por baixo dos panos

- Lead chega via DataCrazy → guardamos telefone + `ad_id` (vindo de `source_id`)
  + `ctwa_clid`.
- Venda chega (Skale/Payt) → procuramos um lead com aquele telefone dentro da
  janela de **30 dias (720 horas)** anteriores à venda (ajustável em
  `JANELA_ATRIBUICAO_HORAS`).
- A comparação de telefone usa os **últimos 9 e os últimos 8 dígitos**. O "9"
  que prefixa celular no Brasil às vezes vem de um lado e não do outro (a Skale
  manda com, o DataCrazy manda sem) — comparar só por 9 dígitos fazia dois
  números da mesma pessoa nunca baterem.
- Se houver mais de um lead na janela, vale o **mais recente**.
- Achou → credita o `ad_id` daquele lead na venda (aparece como "MATCH" na aba
  Vendas). Não achou → a venda fica "sem atribuição" (pode ser orgânico,
  indicação, etc.) e não é tentada de novo.
- Roda a cada webhook de venda recebido e, de novo, a cada 30 minutos. O botão
  **"🔄 Sincronizar agora"** do painel roda o mesmo ciclo na hora.
- Existe uma rota de API pra **reatribuir** um período
  (`POST /api/eventos-manuais/reatribuir`, sem botão no painel): ela zera a
  atribuição daquelas vendas e roda tudo outra vez (útil depois de importar
  leads históricos).

---

## 6. Status das vendas da Skale (Pay After Delivery)

A classificação usa campos específicos do payload (`transaction.payment_status`
e `transaction.payment_method`), nunca uma busca solta pelo JSON:

| Situação no payload | Status aqui | Conta como venda? |
|---|---|---|
| Pagamento confirmado (`payment_status = "Pago"`), seja Antecipada ou After Pay | `aprovada` | Sim |
| `payment_method = "After Pay"` e ainda não pago | `agendamento` | Não — entrega agendada, ainda sem dinheiro |
| Antecipada ainda aguardando confirmação | `desconhecido` | Não — aparece como pendente |
| Recusado | `recusada` | Não |
| Cancelado, estornado ou chargeback | `cancelada` | Não |

Cada evento novo do mesmo pedido atualiza a venda que já existe (a chave é
plataforma + id do pedido), então um agendamento vira `aprovada` sozinho quando
o pagamento confirma — sem duplicar linha.

**"Hoje" é a data real do pagamento** (`paid_at_data` da Skale), não a data de
criação do pedido nem a hora em que o webhook chegou. É o mesmo critério que a
Skale usa nos relatórios dela, então os dois sistemas fecham no mesmo número.
Todas as datas desse fluxo são ancoradas em `-03:00` (Brasília).

---

## 7. Meta CAPI — quem dispara o quê

| Origem | Evento automático | Envio manual |
|---|---|---|
| **Skale** | **Não** | Disponível |
| **Payt** | **Não** | Disponível |
| **DataCrazy** | **Não** | — |

**Nenhum webhook dispara evento pro Meta.** A Skale chegou a enviar Purchase
automático entre 15/09 e 16/09/2026 e foi desligada de novo, voltando à regra
original. Nenhuma origem envia evento de **Lead**.

**Lançar venda manual também não envia nada ao Meta** (desde 16/09/2026) — só
registra a venda no painel.

O único envio existente é a aba **Enviar ao Meta**, na página Eventos Manuais:

1. Você escolhe o **dia do pagamento** e clica em "Ver vendas do dia" — nada é
   enviado ainda. Aparece a lista das vendas **aprovadas** daquele dia, com:
   - se a venda tem o **clique do anúncio** (`ctwa_clid`, o identificador do
     clique que gerou a conversa no WhatsApp — sem ele, o Meta só tem o
     telefone pra casar a conversão com o anúncio);
   - se ela **já foi enviada ao Meta antes** (por este botão ou pelo envio
     automático que existiu entre 15 e 16/09/2026).
2. "Enviar ao Meta" pede confirmação — avisando quantas já tinham sido
   enviadas — e manda o Purchase de todas as vendas da lista pro pixel padrão,
   com o telefone hasheado (SHA-256).
3. O resultado mostra quantas foram **aceitas pelo Meta** e quantas
   **falharam, com o motivo** (ex: nenhum pixel padrão configurado). Trocar a
   data esconde a lista, pra não enviar um dia diferente do que foi conferido.

Por baixo, são as rotas `GET /api/eventos-manuais/vendas-para-meta?data=AAAA-MM-DD`
(pré-visualização) e `POST /api/eventos-manuais/enviar-vendas-meta` (envio).

**Todo envio fica registrado na aba Eventos**, com payload e resposta (ou erro)
— é lá que você confere se algo saiu ou falhou.

---

## 8. Gasto, estrutura e cotação do dólar

- **Gasto**: puxado por anúncio, dia a dia, dos últimos 30 dias a cada
  sincronização, e guardado já convertido em BRL (um registro por anúncio por
  dia).
- **Estrutura**: nome, status e orçamento de campanhas, conjuntos e anúncios,
  mais miniatura e link do post do criativo. Serve pra exibir o painel e pra
  pausar/ativar direto dele.
- **Limpeza**: campanha, conjunto ou anúncio apagado de verdade no Meta some do
  painel sozinho. **Pausado continua aparecendo.** O histórico de gasto e de
  atribuição não é afetado — ele guarda o ID como texto, sem chave estrangeira.
- **Cotação**: cada dia trava a sua cotação na primeira vez que é consultado e
  nunca mais recalcula — sem isso, o valor em BRL de um gasto antigo ficaria
  mudando toda vez que o dólar mexesse. Em Configurações dá pra definir a
  cotação de um dia específico na mão, e escolher o modo de fallback
  (automático ou um valor fixo manual).

---

## 9. Páginas do painel

- **Overview** — gasto, faturamento, ROAS, CPA e lucro do período.
- **Campanhas** — drill-down Campanha → Conjunto → Anúncio.
- **Criativos** — ranking agrupado pelo nome do anúncio (na prática, o nome do
  criativo), somando contas e campanhas diferentes que usam o mesmo nome.
- **Leads** — leads recebidos, com o anúncio de origem.
- **Vendas** — lista com filtro por origem e por status; **Agendamento é um
  desses filtros, dentro da própria página de Vendas**, não uma página à parte.
- **Eventos** — log de tudo que foi enviado ao Meta via CAPI.
- **Eventos Manuais** — três abas: lançar venda manual (sem envio ao Meta),
  cadastro dos produtos do dropdown e **Enviar ao Meta** (seção 7). Lançar lead
  e reatribuir período existem só como rotas de API, sem tela.
- **Configurações** — contas de anúncio, pixels, atendentes, webhooks, cotação
  e marca.

---

## 10. Testes

O teste de aceite (`test/aceite.js`) sobe o sistema de verdade — servidor +
PostgreSQL — e confere o fluxo principal: venda paga na Skale aparecendo na aba
Vendas como `aprovada` e com o anúncio certo, janela de 30 dias, valor em
centavos, evento sem `total_price` sem zerar a venda, lançamento manual com ID
real, e que nada além do botão "Enviar ao Meta" chama o Meta.

```bash
npm test
```

Precisa de um **PostgreSQL local** e de um `.env` com `DATABASE_URL` apontando
pra `localhost`. A cada execução o teste **apaga e recria** o banco
`trakeamento_teste` nesse PostgreSQL (o banco do `.env` não é tocado) — por
isso ele **se recusa a rodar** se o `DATABASE_URL` não for `localhost`. Nenhuma
verificação faz chamada real ao Meta.

**Roda sozinho antes de todo `git push`**: o hook `.githooks/pre-push` cancela
o push se algum teste falhar. Num clone novo, ative com:

```bash
git config core.hooksPath .githooks
```

---

## 11. Segurança

- Só existe **um usuário** (você). Senha guardada com bcrypt; sessão no próprio
  PostgreSQL.
- Tokens do Meta e dos pixels **nunca aparecem completos na tela** — só os
  últimos dígitos.
- Os secrets dos webhooks ficam no banco, editáveis só por você logado, e todo
  webhook rejeita chamada sem o secret certo.
- Vendas de afiliados fora da lista de Atendentes são ignoradas pelo webhook da
  Payt.

---

## 12. Próximos ajustes possíveis

- Calibrar o parser da Payt com um payload real (campo `commission`).
- Na tela de Leads, o nome de campanha/conjunto/anúncio só aparece depois que
  aquele anúncio já teve gasto sincronizado — resolver o nome direto pela Graph
  API quando um `source_id` novo aparecer.
- Exportação de relatórios em CSV/Excel.
- Alertas automáticos (ex: avisar quando o ROAS cair abaixo de X).
