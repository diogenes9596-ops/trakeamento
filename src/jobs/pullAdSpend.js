const cron = require('node-cron');
const { sincronizarTodasContas } = require('../services/metaAdsService');
const { atribuirVendasPendentes } = require('../services/attributionService');

function iniciarJobs() {
  // A cada 30 minutos: puxa gasto das contas de anuncio e roda a atribuicao
  // de vendas pendentes. 30 em 30 min e um bom equilibrio entre "quase tempo
  // real" e nao estourar o limite de chamadas da API do Meta.
  cron.schedule('*/30 * * * *', async () => {
    console.log('[cron] Sincronizando gasto e atribuicao...');
    try {
      const gasto = await sincronizarTodasContas();
      const atribuicao = await atribuirVendasPendentes();
      console.log('[cron] Gasto sincronizado:', gasto);
      console.log('[cron] Atribuicao:', atribuicao);
    } catch (err) {
      console.error('[cron] Erro na sincronizacao automatica:', err);
    }
  });

  console.log('Job automatico agendado: sincronizacao a cada 30 minutos.');
}

module.exports = { iniciarJobs };
