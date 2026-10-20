# Órbita — CRM Open Source com IA

**Conversas viram contexto. Contexto vira próximo passo.**

Self-hosted, local-first conversational CRM for small businesses and community contributors. Órbita connects WhatsApp conversations to a customer pipeline, service delivery and human-confirmed finances, with structured AI classification rather than autonomous business decisions.

**Status: early community preview.** The application works locally; this is a new open-source project, not a mature hosted service. No adoption figures, production-scale guarantees or external endorsements are claimed.

**Origem e republicação:** este repositório republica o código do mesmo projeto inicialmente disponibilizado em 20/10/2026 pela outra conta do mantenedor, `ioraysilva`, e posteriormente transferido para `cioray`. Não representa anos de desenvolvimento público nesta conta nem uma comunidade preexistente. O mantenedor preservou uma cópia do histórico original antes da recriação. Veja [PROVENANCE.md](PROVENANCE.md).

[Contribuir](CONTRIBUTING.md) · [Arquitetura](docs/ARCHITECTURE.md) · [Status](docs/STATUS.md) · [Roadmap](ROADMAP.md) · [Segurança](SECURITY.md)

## Por que existe

Pequenos negócios atendem clientes em conversas, mas pedidos, entregas e pagamentos acabam espalhados pelo histórico. O objetivo do Órbita é oferecer uma base aberta e extensível para organizar esse relacionamento sem obrigar a equipe a abandonar o contexto original.

O código é aberto; execução local, organização comercial e consultas ao histórico não exigem uma assinatura do Órbita. Docker, WhatsApp, Evolution e provedores de IA têm requisitos, termos e eventuais custos próprios. A análise por IA exige uma chave do operador e pode gerar cobrança no provedor.

## Funcionalidades implementadas

- Dashboard, carteira de clientes, pesquisa e funil comercial em Kanban.
- Perfil com solicitações, serviços, notas, oportunidades, tarefas e satisfação proposta pela IA.
- Conversas somente para leitura; chat e perfil em painéis contextuais lado a lado.
- Serviços vinculados ao financeiro: contratado, entrada personalizada, recebido integral e receita pendente editáveis.
- Pagamentos confirmados pelo operador; menções a dinheiro e classificação da IA não viram recebimentos automaticamente.
- Sincronização retomável de mensagens privadas; grupos, status e broadcasts ficam fora da ingestão.
- Janela de catalogação inicial de 30 dias para novas conexões.
- Catalogação de assunto, finança, status e humor em uma requisição por execução de análise de chat, com a conversa dentro da janela disponível.
- Decisões fixadas em **Jev 1.14 via OpenRouter**, sem troca automática por outro modelo.
- Atualização de identidade ao iniciar e a cada 10 minutos: nomes e pares explícitos LID/telefone; identificação manual com prioridade sobre os dados automáticos.
- PostgreSQL com RLS, jobs duráveis, auditoria e outbox para futuras integrações.
- Extração local de PDF/DOCX; áudio depende de transcritor externo configurado.

## Início rápido

Pré-requisitos: Git, Node.js 24+ e Docker com Compose. No Windows, Docker Desktop precisa de virtualização habilitada e backend Linux funcionando.

```bash
git clone https://github.com/cioray/Orbita-CRM-OPEN-SOURCE-COM-IA.git
cd Orbita-CRM-OPEN-SOURCE-COM-IA
npm run bootstrap
docker compose -f compose.community.yaml up -d --build
```

O bootstrap cria `.env` com segredos aleatórios locais, sem copiar credenciais de outros projetos. Não execute o serviço usando os placeholders de `.env.example`.

1. Abra o manager da Evolution em `http://localhost:8080/manager/`. Use sua `EVOLUTION_API_KEY` local e crie a instância `minha-instancia` com integração Baileys. Vincule somente um WhatsApp para o qual você tenha autorização.
2. Abra `http://localhost:8090/crm/` e entre com o `ADMIN_TOKEN` do seu `.env`. No Windows, `scripts/Abrir-CRM.ps1` gera um acesso local de uso único.
3. Em **Instâncias WhatsApp**, confira a associação. Para a instância inicial, `scripts/connect-local.ps1` configura o webhook e inicia a importação observável.
4. Para ativar a catalogação, preencha `OPENROUTER_API_KEY` e recrie API e worker: `docker compose -f compose.community.yaml up -d api worker`.

O QR Code não garante importação completa de todo o histórico do aparelho. A cobertura depende do que o WhatsApp e a Evolution disponibilizarem. Um LID não é um telefone: casos sem vínculo comprovado permanecem pendentes para identificação manual.

Consulte [instalação e operação](docs/SETUP.md) para portas, validação e limitações. O arquivo `compose.yaml` mantém a alternativa avançada de uma Evolution externa na rede `evolution-local_default`.

## Desenvolvimento

```bash
npm ci
npm ci --prefix web
npm run check
npm run build
npm run build --prefix web
npx vitest run tests/ai.test.ts tests/documents.test.ts tests/normalize.test.ts tests/identity.test.ts
```

Testes de banco/CRM precisam de `.env` local e migrations aplicadas. Use um banco descartável, nunca dados de clientes reais. O workflow de CI executa builds, testes unitários e integração com PostgreSQL/Redis isolados.

## Comunidade e objetivos

Contribuições úteis incluem documentação em português, acessibilidade, testes com dados sintéticos, revisão de segurança, melhoria da identificação de contatos e conectores. Veja o [roadmap](ROADMAP.md) e abra uma issue antes de mudanças estruturais.

Este repositório contém somente código e exemplos sintéticos. Não envie conversas, contatos, dumps, sessões de WhatsApp, chaves ou `.env` em issues e pull requests. Não há telemetria própria de produto no Órbita; Evolution e provedores externos possuem políticas independentes. Quando habilitada, a IA recebe conteúdo das conversas para classificação: o operador deve avaliar consentimento, base legal e retenção.

## Limitações e avisos

- Autenticação administrativa local; colaboração multiusuário e permissões granulares ainda são roadmap.
- APIs não oficiais de WhatsApp podem ter limitações, interrupções e riscos para a conta; respeite os termos da plataforma. Não há afiliação com Meta/WhatsApp, Evolution, OpenRouter ou provedores de IA.
- Não é um sistema contábil, de cobrança automática nem de execução de pagamentos.
- Não há envio de mensagens na interface desta versão.
- Não publique as portas diretamente na Internet sem revisão de segurança, TLS e controle de acesso.

## Licença

Código próprio do Órbita sob **GNU AGPL-3.0-only**: veja [LICENSE](LICENSE). Dependências, imagens Docker e serviços externos mantêm suas próprias licenças e termos. A licença deste projeto não relicencia a Evolution ou modelos de IA.
