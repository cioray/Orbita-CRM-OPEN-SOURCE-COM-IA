# Contribuindo com o Órbita

O projeto está no início de sua abertura à comunidade. Contribuições pequenas, verificáveis e documentadas são bem-vindas; não exigimos experiência com inteligência artificial para ajudar.

## Como começar

1. Leia o README, o status e o roadmap.
2. Abra uma issue com problema, contexto, comportamento esperado e proposta. Para arquitetura, privacidade ou mudanças de modelo, discuta antes de implementar.
3. Crie um fork e uma branch com uma alteração focada.
4. Execute TypeScript, builds e os testes relacionados. Descreva exatamente o que foi executado e o que não foi validado.
5. Abra um pull request explicando motivação, solução, limitações e riscos.

## Regras técnicas

- TypeScript estrito; queries SQL parametrizadas; operações de cliente dentro do tenant/RLS.
- Não altere migrations que já possam ter sido aplicadas: acrescente uma nova migration.
- Não introduza modelos alternativos na catalogação: a versão atual fixa Jev 1.14. Mudanças dessa política exigem proposta explícita.
- Não transforme inferência de IA em fato financeiro confirmado. Preserve evidência, auditoria e correções.
- Nunca deduza telefone a partir dos dígitos de um LID. Não una clientes por semelhança de nome.
- Use somente fixtures fictícias. Não envie mensagens reais, capturas da carteira de clientes, backups, arquivos de sessão ou credenciais.
- Mudanças visuais devem incluir captura com dados sintéticos e considerar teclado, contraste e telas pequenas.

## Áreas de contribuição

Documentação PT/EN, acessibilidade, testes de concorrência, instalação em Linux/Windows, resiliência da Evolution, segurança, testes de restauração e conectores desacoplados. Veja ROADMAP.md para distinguir trabalho implementado de objetivos futuros.

## Licenciamento e colaboração

Contribua apenas com código que você tenha direito de distribuir sob AGPL-3.0-only, respeitando atribuições e licenças de terceiros. Não há CLA nem cessão de direitos autorais exigidos nesta versão. A comunicação deve ser respeitosa; siga CODE_OF_CONDUCT.md.
