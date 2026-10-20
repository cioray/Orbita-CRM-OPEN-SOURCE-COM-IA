# Segurança e privacidade

## Estado de suporte

Este é um preview comunitário. Correções são aplicadas à branch principal; não há SLA, auditoria externa concluída ou garantia de adequação a produção. Revise o risco antes de usar dados reais.

## Relatar vulnerabilidades

Use a aba **Security → Report a vulnerability** deste repositório quando disponível. Se não estiver disponível, solicite um canal privado ao mantenedor sem divulgar detalhes exploráveis. Não publique dumps, tokens, senhas, sessões de WhatsApp ou informações de clientes.

Informe versão/commit, configuração relevante sem segredos, impacto, passos mínimos com dados fictícios e sugestão de mitigação. Não teste exploração contra instâncias de terceiros.

## Operação segura

- `.env` é gerado localmente e ignorado pelo Git. Nunca use exemplos como segredos de produção.
- Portas Docker são vinculadas a localhost. Não exponha PostgreSQL, Redis ou o manager da Evolution à Internet.
- O CRM usa acesso administrativo local; autenticação multiusuário, permissões e proteção de exposição pública precisam de trabalho adicional.
- Faça backups criptografados e teste restauração. Git não é um mecanismo de backup para dados pessoais em texto aberto.
- Backups, mídia, dados de contato e sessões precisam de acesso restrito, retenção definida e gestão de chaves.
- Ao habilitar IA, conteúdo das conversas é enviado ao provedor configurado. Avalie base legal, consentimento quando aplicável, termos do provedor e transferência de dados.
- Grupos são ignorados; isso não substitui uma política de privacidade para conversas privadas.
- Rotacione qualquer credencial exposta, mesmo depois de removê-la de um arquivo ou histórico Git.

Não há certificação de conformidade legal. Quem opera a instalação é responsável por avaliar LGPD e outras normas aplicáveis com orientação apropriada.
