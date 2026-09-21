# Documentação - opencode-memory

Esta pasta contém a pesquisa, decisões arquiteturais e planos do plugin.

## Ordem de leitura e precedência

1. **[08-deep-research-and-revised-architecture.md](08-deep-research-and-revised-architecture.md)** — estado arquitetural mais recente e premissas que devem orientar novos agentes.
2. [01-architecture.md](01-architecture.md) a [06-opencode-plugin-api.md](06-opencode-plugin-api.md) — pesquisa inicial; útil como histórico, mas algumas escolhas foram reabertas.
3. [07-implementation-plan.md](07-implementation-plan.md) — **plano antigo preservado como histórico; não executar como plano vigente** até existir um plano v2 derivado do benchmark e da arquitetura revisada.

## Índice

| Arquivo | Descrição | Estado |
|---------|-----------|--------|
| [01-architecture.md](01-architecture.md) | Arquitetura inicial | Histórico / parcialmente superseded |
| [02-laya-research.md](02-laya-research.md) | Pesquisa inicial sobre Laya | Requer correções PT/EN e benchmark |
| [03-embeddings-research.md](03-embeddings-research.md) | Pesquisa inicial de embeddings | Candidatos reabertos |
| [04-reranking-research.md](04-reranking-research.md) | Pesquisa inicial de reranking | Candidatos reabertos |
| [05-vector-store-research.md](05-vector-store-research.md) | Pesquisa inicial de storage vetorial | Backend reaberto |
| [06-opencode-plugin-api.md](06-opencode-plugin-api.md) | Pesquisa inicial da API OpenCode | Revalidar contra V2 atual |
| [07-implementation-plan.md](07-implementation-plan.md) | Primeiro plano de implementação | **Superseded como plano executável** |
| [08-deep-research-and-revised-architecture.md](08-deep-research-and-revised-architecture.md) | Pesquisa aprofundada, arquitetura revisada, decisões e benchmark | **Vigente** |

## Direção atual

A arquitetura vigente não é mais “mensagem → Laya → embedding → ChromaDB”.

O projeto passa a ser orientado por:

- **evidência imutável/auditável** separada de **memória derivada**;
- memórias atômicas com proveniência, escopo, validade e versionamento;
- operações explícitas `ADD / UPDATE / SUPERSEDE / NOOP / CONFLICT`;
- retrieval **lexical + semântico**, com rank fusion e reranking opcional;
- memória procedural de engenharia (`procedure`, `failure_lesson`);
- recall efêmero via `context` hook do OpenCode;
- benchmark PT/EN antes de congelar storage, embedding, reranker e thresholds.

## Componentes: estado das decisões

| Área | Estado |
|------|--------|
| Laya | Mantido como decision engine; checkpoint/default ainda será benchmarkado |
| Embedding | MiniLM deixa de ser default definitivo; multilingual-E5 e EmbeddingGemma entram no benchmark |
| Reranker | Opcional até comprovar ganho |
| Storage | ChromaDB deixa de ser decisão fechada; comparar SQLite/LanceDB/Chroma |
| Retrieval | Híbrido lexical + dense é requisito de design |
| OpenCode | Recall automático deve ocorrer em `context`, não persistindo memória no prompt |
| Worker Python | stdio/RPC é direção preferida a validar frente a FastAPI/porta fixa |

## Próximo marco

Antes da implementação completa, produzir:

1. schema v1 de evidência/memória;
2. invariantes de consolidação;
3. benchmark dataset PT/EN;
4. harness reproduzível;
5. comparação de storage/modelos;
6. plano de implementação v2 baseado nas medições.
