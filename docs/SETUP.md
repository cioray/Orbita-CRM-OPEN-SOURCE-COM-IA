# Instalação e operação

## Preparar

Use Node.js 24+, Git e Docker Compose com containers Linux. Execute `npm run bootstrap`; isso não exige instalar dependências npm e nunca sobrescreve um `.env` existente. Chaves geradas são apenas da sua instalação. A chave OpenRouter deve ser fornecida por você se quiser catalogação.

Suba `docker compose -f compose.community.yaml up -d --build`. O compose comunitário inclui PostgreSQL/Redis para o motor, a Evolution e seus próprios PostgreSQL/Redis. Ele usa volumes separados e não precisa de repositórios irmãos.

## Portas

Padrões locais: CRM 8090, Evolution 8080, PostgreSQL do motor 55432, Redis do motor 26379. Todas as portas expostas ficam em `127.0.0.1`. Altere `CRM_PORT`, `EVOLUTION_PORT`, `DATABASE_PORT` e `QUEUE_PORT` no `.env` se já estiverem ocupadas. Para executar scripts/testes no host, atualize também `DATABASE_URL`, `DATABASE_ADMIN_URL`, `REDIS_URL` e `EVOLUTION_URL` conforme as portas escolhidas. As URLs internas entre containers continuam usando os nomes de serviços. O Windows pode reservar faixas de portas; se houver erro de bind, escolha uma porta fora dessas faixas.

Os scripts PowerShell locais usam a porta CRM padrão 8090. Com porta personalizada, abra o endereço correspondente manualmente ou ajuste a URL do script em uma cópia local. Não publique tokens na URL.

## Vincular WhatsApp

No manager da Evolution, use o endereço local e a chave `EVOLUTION_API_KEY` do `.env`. Crie `minha-instancia` (ou o mesmo nome de `EVOLUTION_INSTANCE`) como Baileys e leia o QR Code com uma conta autorizada. Nunca publique capturas do QR ou arquivos de sessão.

A conexão inicial é registrada pelas migrations, mas isso não cria nem autentica remotamente a instância. A interface mostra instâncias que a Evolution informa. Para configurar webhook e importar pela conexão inicial, execute `scripts/connect-local.ps1` em PowerShell na configuração padrão.

O webhook usa o alias interno `motor-api`; a porta externa permanece privada. A disponibilidade de histórico é uma limitação do provedor. Os nomes dos contatos e vínculos comprovados são atualizados automaticamente a cada dez minutos; não há garantia de resolver todo LID.

## Validar

```bash
docker compose -f compose.community.yaml ps
curl http://localhost:8090/health/ready
docker compose -f compose.community.yaml logs --tail 50 api
```

Entre no CRM com o `ADMIN_TOKEN` local. Não compartilhe logs sem revisar dados pessoais. Sem uma chave OpenRouter válida, a IA não produz classificações reais: não há resultados simulados nem fallback para outro modelo.

## Testes com banco

Use instalação descartável e `.env` próprio. Depois de subir migrations/infra:

```bash
npm ci
npm ci --prefix web
npm run check
npx vitest run tests/workspace.test.ts tests/contact-identity.test.ts tests/service-finance.test.ts
```

Os testes criam tenants temporários e removem seus próprios registros, mas não use um banco de clientes como ambiente de desenvolvimento. Testes da fila exigem Redis acessível nas variáveis de teste.

## Parar e atualizar

`docker compose -f compose.community.yaml down` para containers sem apagar volumes. Não use `down -v` se quiser conservar dados. Antes de atualizar: backup criptografado de PostgreSQL, mídia, configuração e sessão; consulte mudanças e migrations. Restaurar versões antigas de código sobre schemas novos não é uma estratégia de rollback.

O compose avançado `compose.yaml` existe para integração com Evolution externa na rede `evolution-local_default`; use-o somente se essa rede, o serviço `evolution-api` e as credenciais estiverem preparados.
