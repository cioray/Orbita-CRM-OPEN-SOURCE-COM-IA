# Status da versão pública

Snapshot inicial da abertura comunitária, outubro de 2026. Software em preview; arquitetura e interface podem evoluir. Não são apresentados números de usuários, clientes ou colaboradores externos.

## Disponível

Motor de conversas privadas, CRM visual, perfil contextual, funil, serviços, financeiro manual, tarefas/calendário, leitura de chats, associação de evidências, catalogação Jev 1.14, atualização de identidade automática e edição manual, migrations e isolamento por tenant.

## Validação realizada antes da publicação

- Build TypeScript do motor e build de produção React/Vite.
- Testes de workspace, finanças de serviço, identificação, normalização e apresentação de contatos executados com tenants descartáveis.
- Fluxos de interface verificados localmente: perfil, painel financeiro e formulário de identificação.
- Backup operacional privado separado do código público e verificação criptográfica de integridade.

O workflow versionado verifica builds e testes em ambiente limpo; consulte o resultado real da aba Actions. Não presuma que a presença do arquivo de workflow significa execução bem-sucedida.

## Limitações conhecidas

Precisão da catalogação não foi validada em estudo independente. Comportamento sob carga de dez contas, piloto prolongado, recuperação total de histórico e transcrição de áudio ponta a ponta não são garantidos. Os segmentos de negócio iniciais são limitados; generalização é roadmap. Veja SECURITY.md antes de exposição pública.
