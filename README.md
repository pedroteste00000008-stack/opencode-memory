# 🧠 opencode-memory

> Plugin de memória de longo prazo para OpenCode usando Laya + Embeddings + Reranking

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![OpenCode V2](https://img.shields.io/badge/OpenCode-V2-green.svg)](https://opencode.ai)

---

## Visão Geral

O **opencode-memory** é um plugin para o [OpenCode](https://opencode.ai) que implementa um sistema de memória de longo prazo para assistentes de código. Ele combina:

- **[Laya](https://github.com/NandhaKishorM/laya)** — Motor de decisão open-source (alternativa ao Jev) para classificar e decidir o que memorizar
- **[Sentence Transformers](https://www.sbert.net/)** — Embeddings semânticos locais para busca por similaridade
- **[FlashRank](https://github.com/PrithivirajDamodaran/FlashRank)** — Reranking ultrarrápido com cross-encoders
- **[ChromaDB](https://www.trychroma.com/)** — Vector store leve e local

### Por que isso importa?

Sem memória, cada conversa no OpenCode começa do zero. Com este plugin, o assistente:
- Lembra de preferências do usuário (ex: "prefiro TypeScript")
- Retoma decisões técnicas passadas (ex: "usamos PostgreSQL, não MongoDB")
- Evita repetir erros já discutidos
- Mantém contexto entre sessões

---

## Arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│                    OpenCode Plugin                            │
│                                                               │
│  ┌─────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │    Laya     │  │ Sentence         │  │   FlashRank    │  │
│  │  (Decision  │  │ Transformers     │  │  (Cross-Enc    │  │
│  │   Engine)   │  │ (Embeddings)     │  │   Reranker)    │  │
│  └──────┬──────┘  └────────┬─────────┘  └───────┬────────┘  │
│         │                  │                     │            │
│         ▼                  ▼                     ▼            │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                Memory Pipeline                           │ │
│  │                                                          │ │
│  │  Store:  Capture → Classify (Laya) → Embed → Index      │ │
│  │  Recall: Query → Embed → Search → Rerank → Filter (Laya)│ │
│  │  Prune:  Review → Mark obsolete → Delete old            │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│                            ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               ChromaDB (Vector Store)                    │ │
│  │  Collections: facts | conversations | decisions          │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## Componentes

| Componente | Versão | Tamanho | Papel |
|-----------|--------|---------|-------|
| **Laya** | 0.3.5 | ~808MB (English) | Classificação e decisão sobre memórias |
| **Sentence Transformers** | 5.x | ~22MB (MiniLM) | Geração de embeddings semânticos |
| **FlashRank** | latest | ~34MB (MiniLM-L-12) | Reranking de candidatos |
| **ChromaDB** | latest | leve | Armazenamento e busca vetorial |

### Stack Total: ~900MB (com pesos do Laya baixados)

---

## Quick Start

### 1. Instalar dependências Python

```bash
pip install laya sentence-transformers flashrank chromadb
```

### 2. Configurar o plugin no OpenCode

```jsonc
// opencode.jsonc
{
  "plugins": [
    {
      "package": "./plugins/memory",
      "options": {
        "enabled": true,
        "embedding_model": "all-MiniLM-L6-v2",
        "reranker_model": "ms-marco-MiniLM-L-12-v2",
        "laya_checkpoint": "convaiinnovations/laya",
        "max_memories_per_session": 50,
        "importance_threshold": "média"
      }
    }
  ]
}
```

### 3. Uso básico (Python)

```python
import laya
from sentence_transformers import SentenceTransformer
from flashrank import Ranker, RerankRequest
import chromadb

# Inicializar componentes
laya_agent = laya.load("convaiinnovations/laya")
embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
ranker = Ranker(model_name="ms-marco-MiniLM-L-12-v2")
db = chromadb.PersistentClient(path="./.opencode/memory")
collection = db.get_or_create_collection("facts")

# Classificar uma memória
result = laya_agent.predict(
    {"text": "O usuário decidiu usar PostgreSQL"},
    {
        "type": {"type": "choice",
                 "instructions": "Que tipo de informação?",
                 "criteria": {"decision": "Decisão técnica",
                              "preference": "Preferência",
                              "fact": "Fato"}},
        "importance": {"type": "score",
                       "instructions": "Importância?",
                       "criteria": ["baixa", "média", "alta"]}
    }
)

# Armazenar
embedding = embedder.encode("O usuário decidiu usar PostgreSQL")
collection.add(
    documents=["O usuário decidiu usar PostgreSQL"],
    embeddings=[embedding.tolist()],
    metadatas=[{"type": "decision", "importance": "alta"}],
    ids=["mem_001"]
)

# Recuperar
query_emb = embedder.encode("query: qual banco de dados usar?")
results = collection.query(query_embeddings=[query_emb.tolist()], n_results=10)

# Rerank
rerank_req = RerankRequest(
    query="qual banco de dados usar",
    passages=[{"id": i, "text": doc}
              for i, doc in enumerate(results["documents"][0])]
)
reranked = ranker.rerank(rerank_req)
```

---

## Estrutura do Repositório

```
opencode-memory/
├── README.md                   # Este arquivo
├── LICENSE                     # MIT License
├── docs/
│   ├── 01-architecture.md      # Arquitetura detalhada
│   ├── 02-laya-research.md     # Pesquisa sobre Laya
│   ├── 03-embeddings-research.md # Pesquisa sobre embeddings
│   ├── 04-reranking-research.md  # Pesquisa sobre reranking
│   ├── 05-vector-store-research.md # Pesquisa sobre vector stores
│   ├── 06-opencode-plugin-api.md  # API de plugins do OpenCode
│   └── 07-implementation-plan.md  # Plano de implementação
├── src/                        # Código TypeScript do plugin
│   └── (a implementar)
└── python/                     # Scripts Python
    └── (a implementar)
```

---

## Status do Projeto

| Fase | Status |
|------|--------|
| Pesquisa de componentes | ✅ Concluída |
| Definição de arquitetura | ✅ Concluída |
| Documentação | ✅ Concluída |
| Implementação do plugin | ⏳ Pendente |
| Testes | ⏳ Pendente |
| Publicação | ⏳ Pendente |

---

## Licença

MIT License - veja [LICENSE](LICENSE) para detalhes.

---

## Créditos

- **Laya** por [Convai Innovations](https://github.com/NandhaKishorM/laya) — Apache 2.0
- **Sentence Transformers** por [UKP Lab](https://www.sbert.net/) — Apache 2.0
- **FlashRank** por [Prithivi Da](https://github.com/PrithivirajDamodaran/FlashRank) — Apache 2.0
- **ChromaDB** por [Chroma](https://www.trychroma.com/) — Apache 2.0
