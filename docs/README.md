# Documentação - opencode-memory

Esta pasta contém toda a documentação de pesquisa e planejamento do plugin de memória.

## Índice

| Arquivo | Descrição |
|---------|-----------|
| [01-architecture.md](01-architecture.md) | Arquitetura detalhada do plugin |
| [02-laya-research.md](02-laya-research.md) | Pesquisa sobre o Laya (motor de decisão) |
| [03-embeddings-research.md](03-embeddings-research.md) | Pesquisa sobre modelos de embedding |
| [04-reranking-research.md](04-reranking-research.md) | Pesquisa sobre reranking |
| [05-vector-store-research.md](05-vector-store-research.md) | Pesquisa sobre vector stores |
| [06-opencode-plugin-api.md](06-opencode-plugin-api.md) | API de plugins do OpenCode V2 |
| [07-implementation-plan.md](07-implementation-plan.md) | Plano de implementação detalhado |

## Resumo da Pesquisa

### Componentes Selecionados

| Componente | Modelo | Justificativa |
|-----------|--------|---------------|
| **Decisão** | Laya (convaiinnovations/laya) | Open-source, 33ms, probabilidades calibradas |
| **Embeddings** | Sentence Transformers (all-MiniLM-L6-v2) | 22MB, 384 dims, ~14ms, CPU-friendly |
| **Reranking** | FlashRank (ms-marco-MiniLM-L-12-v2) | 34MB, ONNX, <100ms, sem PyTorch |
| **Vector Store** | ChromaDB | Zero config, persistente, CRUD completo |

### Stack Total

- **Tamanho**: ~900MB (com pesos do Laya)
- **Latência por recall**: ~138ms
- **Precisão esperada**: ~85%+ (com reranking)
- **Custo**: $0 (tudo self-hosted, Apache 2.0)
