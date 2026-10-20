export const TAXONOMY_VERSION = '2026-10-19-v1';
export const intentions = {
  automation_quote: 'Solicita orçamento, demonstração ou compra de automação, CRM ou integração.',
  automation_support: 'Pede suporte, correção ou alteração de uma automação ou integração.',
  course_information: 'Pede informações sobre curso para barbeiros, conteúdo, turma, duração ou requisitos.',
  course_enrollment: 'Quer se matricular, comprar ou confirmar inscrição em curso para barbeiros.',
  course_support: 'Pede acesso às aulas, certificado, material ou suporte de aluno de curso.',
  scheduling: 'Combina, altera ou pergunta sobre horário, reunião ou aula.',
  payment: 'Trata de preço, cobrança, parcela, pagamento ou reembolso.',
  cancellation: 'Solicita cancelamento de compra, serviço, matrícula ou compromisso.',
  acknowledgement: 'Apenas confirma, agradece ou responde brevemente; considerar a mensagem citada.',
  other: 'Assunto compreensível mas fora das categorias comerciais.',
  unknown: 'Contexto insuficiente ou conteúdo não interpretável.'
};
export const financialKinds = {
  quoted_price: 'Preço citado ou orçamento ainda não aceito.',
  agreed_amount: 'Valor associado a acordo explicitamente aceito pelas partes.',
  installment: 'Valor de uma parcela, não necessariamente o total.',
  payment_claimed: 'Alguém afirma que pagou ou recebeu; não há confirmação externa neste motor.',
  refund_mentioned: 'Valor referente a devolução, reembolso ou estorno mencionado.',
  unrelated: 'Número não representa fato financeiro desse relacionamento.',
  unknown: 'Não é possível determinar o papel do valor.'
};

export interface MoneyCandidate { id: string; raw: string; decimal: string; currency: 'BRL'; start: number; end: number }
export function moneyCandidates(text: string): MoneyCandidate[] {
  const expression = /(?:R\$\s*)(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)(?!\d)/g;
  const results: MoneyCandidate[] = [];
  for (const match of text.matchAll(expression)) {
    const value = match[1];
    if (!value) continue;
    const [whole, fraction = '00'] = value.replace(/\./g, '').split(',');
    if (!whole) continue;
    const decimal = `${BigInt(whole).toString()}.${fraction.padEnd(2, '0')}`;
    const start = [...text.slice(0, match.index)].length;
    results.push({ id: `amount_${results.length}`, raw: match[0], decimal, currency: 'BRL', start, end: start + [...match[0]].length });
  }
  return results;
}
