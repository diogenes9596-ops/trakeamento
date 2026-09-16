// Teste de aceite -- roda o sistema de verdade (servidor + PostgreSQL local)
// e confere o fluxo principal. Uso: npm test
//
// Criterio de aceite do usuario: "uma venda com pagamento confirmado na Skale
// aparece na aba Vendas em ate 1 minuto, com status 'aprovada' e o anuncio
// certo preenchido sempre que existir um lead correspondente dentro da janela
// de 30 dias."
//
// Como funciona: a cada execucao APAGA e recria o banco "trakeamento_teste" no
// mesmo PostgreSQL do DATABASE_URL do .env, aplica o schema.sql, sobe o
// servidor numa porta propria e roda as verificacoes. Por apagar dados, SO
// roda com DATABASE_URL apontando pra localhost -- nunca contra producao.
// Nenhuma verificacao faz chamada real ao Meta (nao existe pixel no banco de teste).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Pool } = require('pg');

const REPO = path.resolve(__dirname, '..');
const BANCO_TESTE = 'trakeamento_teste';
const PORTA_TESTE = '3998';
const BASE = `http://localhost:${PORTA_TESTE}`;

function lerEnv() {
  const arquivo = path.join(REPO, '.env');
  if (!fs.existsSync(arquivo)) {
    console.error('Sem .env na raiz do projeto -- o teste precisa do DATABASE_URL do PostgreSQL local.');
    process.exit(2);
  }
  return Object.fromEntries(
    fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)
      .filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
}

const env = lerEnv();
const urlLocal = new URL(env.DATABASE_URL || 'postgres://invalido');
if (urlLocal.hostname !== 'localhost') {
  console.error(`RECUSADO: DATABASE_URL aponta pra "${urlLocal.hostname}", nao pra localhost. ` +
    'Este teste apaga e recria um banco -- so roda contra o PostgreSQL local.');
  process.exit(2);
}
const urlAdmin = new URL(urlLocal); urlAdmin.pathname = '/postgres';
const urlTeste = new URL(urlLocal); urlTeste.pathname = `/${BANCO_TESTE}`;

const envTeste = {
  ...process.env,
  DATABASE_URL: urlTeste.toString(),
  PORT: PORTA_TESTE,
  SESSION_SECRET: 'teste-aceite-local',
  ADMIN_EMAIL: 'aceite@teste.local',
  ADMIN_PASSWORD: 'teste-aceite-local', // usuario do banco descartavel de teste
  JANELA_ATRIBUICAO_HORAS: '720',
  // Mesmo fuso do Railway. Sem isso, nesta maquina (fuso de Brasilia) um bug
  // de "data sem fuso" passaria despercebido no teste.
  TZ: 'UTC',
};

const resultados = [];
function checar(nome, ok, detalhe) {
  resultados.push({ nome, ok: !!ok });
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${nome}${detalhe !== undefined ? '  -> ' + detalhe : ''}`);
}
const dormir = ms => new Promise(r => setTimeout(r, ms));

// Pedidos de teste: pagos em 16/09/2026 14:30 no horario de Brasilia
const PAGO_EM = new Date('2026-09-16T14:30:00-03:00');
const diasAntes = d => new Date(PAGO_EM.getTime() - d * 86400000);

let servidor;
let logServidor = '';
let pool;

function carregarUtil(nome) {
  try {
    return require(path.join(REPO, 'src', 'utils', nome));
  } catch (err) {
    checar(`modulo src/utils/${nome}.js existe`, false, err.message.split('\n')[0]);
    return null;
  }
}

function verificarRegrasPuras() {
  const telefone = carregarUtil('telefone');
  const datas = carregarUtil('datas');
  if (!telefone || !datas) return;

  const { normalizarTelefoneBR } = telefone;
  const casosTelefone = [
    ['(55) 99123-4567', '5555991234567', 'celular DDD 55 (RS) sem DDI'],
    ['(55) 3222-1234', '555532221234', 'fixo DDD 55 (RS) sem DDI'],
    ['+55 55 99123-4567', '5555991234567', 'celular DDD 55 com DDI'],
    ['+55 (11) 98765-0001', '5511987650001', 'celular DDD 11 com DDI'],
    ['11987650001', '5511987650001', 'celular DDD 11 sem DDI'],
    ['', null, 'vazio'],
  ];
  for (const [entrada, esperado, nome] of casosTelefone) {
    const obtido = normalizarTelefoneBR(entrada);
    checar(`telefone: ${nome}`, obtido === esperado, `${entrada || '(vazio)'} -> ${obtido}`);
  }

  const { hojeEmBrasilia, diasAtrasEmBrasilia, instanteDeBrasilia } = datas;
  const noite = new Date('2026-09-17T01:30:00Z'); // 16/09 22:30 em Brasilia, ja 17/09 em UTC
  checar('"hoje" as 22:30 de Brasilia continua sendo o mesmo dia', hojeEmBrasilia(noite) === '2026-09-16', hojeEmBrasilia(noite));
  checar('"7 dias atras" contado em Brasilia', diasAtrasEmBrasilia(7, noite) === '2026-09-09', diasAtrasEmBrasilia(7, noite));
  checar('data/hora sem fuso e lida como Brasilia', instanteDeBrasilia('2026-09-16 22:30:00')?.toISOString() === '2026-09-17T01:30:00.000Z',
    instanteDeBrasilia('2026-09-16 22:30:00')?.toISOString());
  checar('data/hora com fuso e respeitada', instanteDeBrasilia('2026-09-16T22:30:00Z')?.toISOString() === '2026-09-16T22:30:00.000Z');
}

async function main() {
  verificarRegrasPuras();

  // --- banco novo a cada execucao ---
  const admin = new Pool({ connectionString: urlAdmin.toString() });
  await admin.query(`DROP DATABASE IF EXISTS ${BANCO_TESTE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${BANCO_TESTE}`);
  await admin.end();

  const migracao = spawnSync(process.execPath, ['src/db-migrate.js'], { cwd: REPO, env: envTeste, encoding: 'utf8' });
  checar('schema.sql aplica num banco vazio', migracao.status === 0, migracao.status === 0 ? undefined : migracao.stderr || migracao.stdout);
  if (migracao.status !== 0) return;

  // --- servidor ---
  servidor = spawn(process.execPath, ['src/server.js'], { cwd: REPO, env: envTeste });
  servidor.stdout.on('data', d => { logServidor += d; });
  servidor.stderr.on('data', d => { logServidor += d; });
  let noAr = false;
  for (let i = 0; i < 60 && !noAr; i++) {
    try { noAr = (await fetch(`${BASE}/webhook/skale`)).ok; } catch (e) { await dormir(250); }
  }
  checar('servidor sobe', noAr);
  if (!noAr) { console.log(logServidor); return; }

  pool = new Pool({ connectionString: urlTeste.toString(), options: '-c timezone=America/Sao_Paulo' });

  // --- dados de apoio ---
  await pool.query(`INSERT INTO meta_campaigns (id, nome, status) VALUES ('CAMP_TESTE', 'Campanha Teste', 'ACTIVE')`);
  await pool.query(`INSERT INTO meta_adsets (id, campaign_id, nome, status) VALUES ('SET_TESTE', 'CAMP_TESTE', 'Conjunto Teste', 'ACTIVE')`);
  await pool.query(`INSERT INTO meta_ads (id, adset_id, campaign_id, nome, status) VALUES ('AD_TESTE_NOVO', 'SET_TESTE', 'CAMP_TESTE', 'Anuncio Teste Novo', 'ACTIVE')`);
  // Cliente A: dois leads na janela. Lead SEM o 9 do celular, venda COM o 9
  // -- exercita a comparacao pelos ultimos 8 digitos.
  await pool.query(`INSERT INTO leads (telefone, ad_id, recebido_em) VALUES ('551187650001', 'AD_TESTE_VELHO', $1)`, [diasAntes(20)]);
  await pool.query(`INSERT INTO leads (telefone, ad_id, ctwa_clid, recebido_em) VALUES ('551187650001', 'AD_TESTE_NOVO', 'CLID_TESTE', $1)`, [diasAntes(10)]);
  // Cliente B: unico lead ha 35 dias -- fora da janela de 30.
  await pool.query(`INSERT INTO leads (telefone, ad_id, recebido_em) VALUES ('5511912340002', 'AD_FORA_JANELA', $1)`, [diasAntes(35)]);
  // Cliente do RS (DDD 55): lead no MESMO dia da venda manual, as 15h
  await pool.query(`INSERT INTO leads (telefone, ad_id, recebido_em) VALUES ('5555991234567', 'AD_MESMO_DIA', '2026-09-16T15:00:00-03:00')`);

  const token = (await pool.query(`SELECT secret FROM webhook_secrets WHERE servico = 'skale'`)).rows[0]?.secret;
  checar('secret do webhook da Skale existe', token);

  const postarSkale = async payload => (await fetch(`${BASE}/webhook/skale?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })).status;

  async function esperarVenda(idExterno, condicao = () => true, limiteMs = 60000) {
    const inicio = Date.now();
    while (Date.now() - inicio < limiteMs) {
      const v = (await pool.query(`SELECT * FROM sales WHERE plataforma = 'skale' AND id_externo = $1`, [idExterno])).rows[0];
      if (v && v.atribuido_em && condicao(v)) return { venda: v, ms: Date.now() - inicio };
      await dormir(100);
    }
    return { venda: null, ms: Date.now() - inicio };
  }

  // === 1. CRITERIO DE ACEITE ===
  const pedidoA = {
    event: 'order_updated',
    transaction_id: 'ven_TESTE01',
    customer: { name: 'Cliente Teste A', phone: '+55 (11) 98765-0001', email: 'a@teste.dev' },
    product: { name: '6 MESES' },
    transaction: { payment_status: 'Pago', payment_method: 'Antecipada', total_price: 29700, paid_at_data: '2026-09-16', paid_at_hora: '14:30:00' },
  };
  checar('webhook da Skale responde 200', (await postarSkale(pedidoA)) === 200);
  const { venda: a, ms } = await esperarVenda('ven_TESTE01');
  checar('venda gravada e atribuida em ate 1 minuto', a, `${ms} ms`);
  if (a) {
    checar('status = aprovada', a.status === 'aprovada', a.status);
    checar('anuncio = lead mais recente dentro da janela', a.ad_id === 'AD_TESTE_NOVO', a.ad_id);
    checar('valor = total_price / 100', Number(a.valor) === 297, a.valor);
    checar('data = pagamento real em -03:00', new Date(a.recebido_em).getTime() === PAGO_EM.getTime(), new Date(a.recebido_em).toISOString());
    checar('nome, e-mail e produto dos campos confirmados',
      a.nome_cliente === 'Cliente Teste A' && a.email === 'a@teste.dev' && a.produto === '6 MESES',
      `${a.nome_cliente} | ${a.email} | ${a.produto}`);
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: envTeste.ADMIN_EMAIL, senha: envTeste.ADMIN_PASSWORD }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  checar('login no painel', login.ok);
  const api = (rota, opcoes = {}) => fetch(`${BASE}${rota}`, {
    ...opcoes, headers: { 'Content-Type': 'application/json', cookie, ...(opcoes.headers || {}) },
  });

  const vendas = await (await api('/api/dashboard/vendas?origem=skale&status=aprovada&data_inicio=2026-09-16&data_fim=2026-09-16')).json();
  const naTela = Array.isArray(vendas) && vendas.find(v => v.id_externo === 'ven_TESTE01');
  checar('aparece na aba Vendas (Skale + Aprovada, dia do pagamento)', naTela);
  checar('aba Vendas mostra o nome do anuncio certo', naTela && naTela.ad_name === 'Anuncio Teste Novo', naTela && naTela.ad_name);

  // === 2. Evento tardio SEM total_price nao zera a venda ===
  const rastreio = JSON.parse(JSON.stringify(pedidoA));
  delete rastreio.transaction.total_price;
  rastreio.tracking_code = 'BR123TESTE';
  await postarSkale(rastreio);
  const { venda: a2 } = await esperarVenda('ven_TESTE01', v => v.payload_bruto?.tracking_code === 'BR123TESTE');
  checar('evento sem total_price mantem o valor', a2 && Number(a2.valor) === 297, a2 && a2.valor);
  checar('evento sem total_price mantem status e anuncio', a2 && a2.status === 'aprovada' && a2.ad_id === 'AD_TESTE_NOVO');

  // === 3. Produto abaixo de R$ 100 + lead fora da janela ===
  await postarSkale({
    event: 'order_updated', transaction_id: 'ven_TESTE02',
    customer: { name: 'Cliente Teste B', phone: '11912340002', email: 'b@teste.dev' }, product: { name: '1 MES' },
    transaction: { payment_status: 'Pago', payment_method: 'Antecipada', total_price: 9700, paid_at_data: '2026-09-16', paid_at_hora: '15:00:00' },
  });
  const { venda: b } = await esperarVenda('ven_TESTE02');
  checar('produto de R$ 97,00 grava 97 (codigo antigo gravava 9700)', b && Number(b.valor) === 97, b && b.valor);
  checar('lead de 35 dias atras NAO e atribuido (janela de 30)', b && b.ad_id === null, b && b.ad_id);

  // Pedido pendente (Antecipada aguardando) -- nao pode ir pro envio ao Meta
  await postarSkale({
    event: 'order_updated', transaction_id: 'ven_TESTE04',
    customer: { name: 'Cliente Pendente', phone: '11955550004' }, product: { name: '3 MESES' },
    transaction: { payment_status: 'Aguardando Pagamento', payment_method: 'Antecipada', total_price: 49700 },
  });
  const { venda: d } = await esperarVenda('ven_TESTE04');
  checar('Antecipada aguardando = desconhecido', d && d.status === 'desconhecido', d && d.status);

  // Bug real (ven_158205): a versao do webhook no ar de 09/09 17:27 a 11/09
  // 20:11 procurava "Pago" em QUALQUER campo do payload e marcou como aprovada
  // um pedido com todas as cobrancas recusadas. O status so pode vir de
  // transaction.payment_status.
  await postarSkale({
    event: 'order_updated', transaction_id: 'ven_TESTE05',
    status_comissao: 'Pago', // "Pago" na raiz: a busca cega achava esse antes de tudo
    customer: { name: 'Cliente Recusado', phone: '11966660005' }, product: { name: '3 MESES' },
    historico: [{ descricao: 'Parcela anterior', status: 'Pago' }], // e aninhado
    transaction: { payment_status: 'Pagamento recusado', payment_method: 'Cartão de Crédito', total_price: 48300 },
  });
  const { venda: e } = await esperarVenda('ven_TESTE05');
  checar('pagamento recusado com "Pago" em outro campo vira recusada, nunca aprovada', e && e.status === 'recusada', e && e.status);

  // Telefone DDD 55 sem DDI + pagamento so com paid_at (sem fuso no texto).
  // Servidor em UTC: "2026-09-15 22:30:00" tem que ser 22:30 de Brasilia.
  await postarSkale({
    event: 'order_updated', transaction_id: 'ven_TESTE07',
    customer: { name: 'Cliente RS Fixo', phone: '(55) 3222-1234' }, product: { name: '1 MES' },
    transaction: { payment_status: 'Pago', payment_method: 'Antecipada', total_price: 19700, paid_at: '2026-09-15 22:30:00' },
  });
  const { venda: g } = await esperarVenda('ven_TESTE07');
  checar('webhook: telefone DDD 55 sem DDI ganha o 55', g && g.telefone === '555532221234', g && g.telefone);
  checar('webhook: paid_at sem fuso lido como Brasilia (servidor em UTC)',
    g && new Date(g.recebido_em).toISOString() === '2026-09-16T01:30:00.000Z', g && new Date(g.recebido_em).toISOString());

  // === 4. Lancamento manual: id real, 409 em duplicata, sem envio ao Meta ===
  const manual = await api('/api/eventos-manuais/lancar-venda', {
    // data fixa: sem ela a venda cairia no dia em que o teste roda
    method: 'POST', body: JSON.stringify({ id_externo: 'ven_TESTE03', telefone: '11987650001', nome: 'Manual Teste', valor: '150', data: '2026-09-16' }),
  });
  const m = await manual.json();
  checar('lancamento manual responde 201', manual.status === 201, manual.status);
  checar('lancamento manual grava plataforma skale com o id real', m.plataforma === 'skale' && m.id_externo === 'ven_TESTE03');
  const dup = await api('/api/eventos-manuais/lancar-venda', {
    method: 'POST', body: JSON.stringify({ id_externo: 'ven_TESTE01', telefone: '11987650001', valor: '1' }),
  });
  checar('lancar ID que ja existe responde 409', dup.status === 409, dup.status);

  // Venda manual so com data, cliente do RS (DDD 55) sem DDI, com lead as 15h
  // do mesmo dia. A venda vai pra 23:59:59 -03:00, entao o lead e atribuido
  // (com o horario antigo, 09:00 de Brasilia, o lead "vinha depois").
  const mesmoDia = await api('/api/eventos-manuais/lancar-venda', {
    method: 'POST', body: JSON.stringify({ id_externo: 'ven_TESTE06', telefone: '55991234567', nome: 'Cliente RS', valor: '100', data: '2026-09-16' }),
  });
  const md = await mesmoDia.json();
  checar('manual: telefone DDD 55 sem DDI ganha o 55', md.telefone === '5555991234567', md.telefone);
  checar('manual: venda so com data vai pra 23:59:59 de Brasilia',
    md.recebido_em && new Date(md.recebido_em).toISOString() === '2026-09-17T02:59:59.000Z', md.recebido_em && new Date(md.recebido_em).toISOString());
  const md2 = (await pool.query(`SELECT ad_id FROM sales WHERE id_externo = 'ven_TESTE06'`)).rows[0];
  checar('manual: lead do mesmo dia (15h) e atribuido', md2 && md2.ad_id === 'AD_MESMO_DIA', md2 && md2.ad_id);
  const dataRuim = await api('/api/eventos-manuais/lancar-venda', {
    method: 'POST', body: JSON.stringify({ id_externo: 'ven_TESTE08', telefone: '11900000008', valor: '1', data: '16/09/2026' }),
  });
  checar('manual: data em formato invalido responde 400', dataRuim.status === 400, dataRuim.status);

  // Toda chamada ao CAPI sem pixel escreve essa linha no log do servidor.
  const chamadasCapi = () => (logServidor.match(/Nenhum pixel default configurado/g) || []).length;
  await dormir(500);
  checar('webhook e lancamento manual NAO chamaram o CAPI', chamadasCapi() === 0, `${chamadasCapi()} chamada(s)`);

  // === 5. Reprocessar atribuicao: datas como parametro, nunca coladas no SQL ===
  const injecao = await api('/api/dashboard/reprocessar-atribuicao', {
    method: 'POST', body: JSON.stringify({ data_inicio: "2026-09-16' OR '1'='1", data_fim: '2026-09-16' }),
  });
  checar('reprocessar atribuicao recusa data com SQL injetado (400)', injecao.status === 400, injecao.status);
  const reproc = await api('/api/dashboard/reprocessar-atribuicao', {
    method: 'POST', body: JSON.stringify({ data_inicio: '2026-09-16', data_fim: '2026-09-16' }),
  });
  const rr = await reproc.json();
  // no dia, so ven_TESTE02 esta aprovada e sem anuncio
  checar('reprocessar atribuicao com datas validas reprocessa so as sem anuncio do periodo', reproc.ok && rr.resetadas === 1, `${reproc.status}, resetadas=${rr.resetadas}`);

  // === 6. Aba "Enviar ao Meta" ===
  // Simula um Purchase ja aceito antes pro ven_TESTE02
  await pool.query(
    `INSERT INTO eventos_capi (evento, pixel_id, status, payload) VALUES ('Purchase', 'PIXEL_TESTE', 'ok', $1)`,
    [JSON.stringify({ enviado: { event_id: 'manual_skale_ven_TESTE02' } })]
  );
  const prev = await (await api('/api/eventos-manuais/vendas-para-meta?data=2026-09-16')).json();
  const ids = (prev.vendas || []).map(v => v.id_externo).sort();
  checar('pre-visualizacao lista so as aprovadas do dia', JSON.stringify(ids) === JSON.stringify(['ven_TESTE01', 'ven_TESTE02', 'ven_TESTE03', 'ven_TESTE06']), ids.join(', '));
  const pA = (prev.vendas || []).find(v => v.id_externo === 'ven_TESTE01');
  const pB = (prev.vendas || []).find(v => v.id_externo === 'ven_TESTE02');
  checar('pre-visualizacao marca quem tem clique do anuncio (ctwa_clid)', pA?.tem_ctwa_clid === true && pB?.tem_ctwa_clid === false);
  checar('pre-visualizacao marca venda ja enviada ao Meta', pB?.ja_enviada === true && pA?.ja_enviada === false);
  checar('pre-visualizacao NAO envia nada ao Meta', chamadasCapi() === 0, `${chamadasCapi()} chamada(s)`);
  checar('data invalida responde 400', (await api('/api/eventos-manuais/vendas-para-meta?data=16-09-2026')).status === 400);

  // Sem pixel configurado o envio tem que aparecer como FALHA -- antes a rota
  // contava como "enviado" mesmo sem enviar nada. A venda ja aceita pelo Meta
  // (ven_TESTE02) e pulada, sem tentar enviar.
  const envio = await (await api('/api/eventos-manuais/enviar-vendas-meta', { method: 'POST', body: JSON.stringify({ data: '2026-09-16' }) })).json();
  checar('envio sem pixel: 0 enviadas e 3 falhas com o motivo',
    envio.enviados?.length === 0 && envio.falhas?.length === 3 && envio.falhas.every(f => /pixel/i.test(f.erro)),
    `${envio.enviados?.length} enviadas, ${envio.falhas?.length} falhas`);
  checar('envio pula a venda ja aceita pelo Meta', envio.puladas?.length === 1 && envio.puladas[0].nome === 'Cliente Teste B',
    `${envio.puladas?.length} pulada(s)`);
  // Controle: a rota de envio chama o CAPI (3 vezes, a pulada nao) -- prova que o detector acima enxerga chamadas.
  checar('controle: o detector enxerga o envio manual, sem a venda pulada', chamadasCapi() === 3, `${chamadasCapi()} chamada(s)`);
}

main()
  .catch(err => { checar('execucao sem erro inesperado', false, err.stack); })
  .finally(async () => {
    if (servidor) servidor.kill();
    if (pool) await pool.end().catch(() => {});
    const falhas = resultados.filter(r => !r.ok).length;
    console.log(`\n${resultados.length - falhas}/${resultados.length} verificacoes passaram.`);
    process.exit(falhas || resultados.length === 0 ? 1 : 0);
  });
