// Telefone brasileiro pra gravar no banco: so digitos, com o DDI 55.
//
// A regra antiga ("se nao comeca com 55, coloca 55") confundia o DDI do Brasil
// com o DDD 55 do Rio Grande do Sul: um celular de Santa Maria digitado sem DDI
// -- (55) 99123-4567 -> "55991234567" -- ja "comecava com 55" e era gravado
// sem o DDI. Agora a decisao e pelo tamanho:
//   10 ou 11 digitos (DDD + numero) -> sem DDI: acrescenta 55
//   qualquer outro tamanho          -> mantem como veio (12/13 com DDI, ou
//                                      formato inesperado: nao adivinha)
//
// A atribuicao compara so os ultimos 9 e 8 digitos, entao nao depende disso --
// mas o telefone gravado e o hash enviado ao Meta dependem.
function normalizarTelefoneBR(telefone) {
  const digitos = String(telefone ?? '').replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.length === 10 || digitos.length === 11) return '55' + digitos;
  return digitos;
}

module.exports = { normalizarTelefoneBR };
