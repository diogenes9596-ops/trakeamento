// Datas sempre ancoradas no horario de Brasilia.
//
// O servidor de producao (Railway) roda em UTC. toISOString() devolve a data
// em UTC -- depois das 21h de Brasilia ela ja e o dia seguinte -- e um texto de
// data/hora SEM fuso e interpretado no fuso do servidor. As duas coisas ja
// jogaram venda no dia errado e quebraram atribuicao (ver CLAUDE.md).

const FUSO_BRASILIA = 'America/Sao_Paulo';

// "AAAA-MM-DD" do dia em Brasilia no instante informado
function dataEmBrasilia(instante = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_BRASILIA }).format(instante);
}

function hojeEmBrasilia(agora = new Date()) {
  return dataEmBrasilia(agora);
}

// O Brasil nao tem horario de verao desde 2019, entao 1 dia = 24h.
function diasAtrasEmBrasilia(dias, agora = new Date()) {
  return dataEmBrasilia(new Date(agora.getTime() - dias * 86400000));
}

// Converte texto de data/hora num instante. Texto SEM fuso ("2026-09-16 22:30:00"
// ou so "2026-09-16") e lido como horario de Brasilia; texto que ja traz fuso
// ("...Z", "...-03:00") e respeitado. Devolve null se nao for data valida.
function instanteDeBrasilia(texto) {
  let s = String(texto ?? '').trim().replace(' ', 'T');
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  const temFuso = /T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(temFuso ? s : `${s}-03:00`);
  return isNaN(d.getTime()) ? null : d;
}

module.exports = { FUSO_BRASILIA, hojeEmBrasilia, diasAtrasEmBrasilia, instanteDeBrasilia };
