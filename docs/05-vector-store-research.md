# Pesquisa: Vector Store

## O que é um Vector Store?

Um vector store é um banco de dados especializado em armazenar e buscar vetores (embeddings) por similaridade. Diferente de bancos relacionais que buscam por exatidão ou texto, vector stores usam distância cosine, L2 ou dot product para encontrar itens similares.

---

## Opções Avaliadas

### 1. ChromaDB (Recomendado ✅)

**Website**: https://www.trychroma.com/
**GitHub**: https://github.com/chroma-core/chroma
**Licença**: Apache 2.0
**Instalação**: `pip install chromadb`

#### Características

```
✅ Zero config — roda in-process, sem servidor
✅ Persistência automática em disco
✅ CRUD completo (add, update, delete, query)
✅ Filtragem por metadata
✅ Embedding function customizada
✅ Até ~1M documentos com boa performance
✅ Integra com LangChain/LlamaIndex
```

#### Código de uso

```python
import chromadb

# Criar cliente persistente
client = chromadb.PersistentClient(path="./.opencode/memory")

# Criar collection
collection = client.get_or_create_collection(
    name="facts",
    metadata={"hnsw:space": "cosine"}  # cosine similarity
)

# Adicionar documentos
collection.add(
    documents=[
        "O usuário prefere TypeScript sobre JavaScript",
        "O projeto usa PostgreSQL como banco de dados",
        "Decidimos usar Docker para deploy"
    ],
    metadatas=[
        {"type": "preference", "importance": "alta"},
        {"type": "decision", "importance": "alta"},
        {"type": "decision", "importance": "média"}
    ],
    ids=["mem_001", "mem_002", "mem_003"]
)

# Buscar
results = collection.query(
    query_texts=["qual linguagem o usuário gosta?"],
    n_results=2
)
# {
#   "documents": [["O usuário prefere TypeScript sobre JavaScript", ...]],
#   "metadatas": [[{"type": "preference", ...}, ...]],
#   "distances": [[0.15, 0.42]],
#   "ids": [["mem_001", "mem_002"]]
# }

# Filtrar por metadata
results = collection.query(
    query_texts=["qual decisão foi tomada?"],
    n_results=5,
    where={"type": "decision"}
)

# Atualizar
collection.update(
    ids=["mem_001"],
    documents=["O usuário prefere TypeScript (atualizado)"],
    metadatas=[{"type": "preference", "importance": "alta", "updated": true}]
)

# Deletar
collection.delete(ids=["mem_003"])
```

#### Com embedding function customizada

```python
import chromadb
from sentence_transformers import SentenceTransformer

class MiniLMEmbeddingFunction:
    def __init__(self):
        self.model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

    def __call__(self, input: list[str]) -> list[list[float]]:
        return self.model.encode(input).tolist()

ef = MiniLMEmbeddingFunction()
client = chromadb.PersistentClient(path="./memory")

collection = client.get_or_create_collection(
    "facts",
    embedding_function=ef
)

# Agora ChromaDB usa automaticamente o MiniLM para embeddings
collection.add(
    documents=["O usuário prefere TypeScript"],
    ids=["mem_001"]
)
```

#### Performance

| Operação | Latência (1K docs) | Latência (100K docs) |
|----------|-------------------|---------------------|
| Add (batch) | ~10ms | ~500ms |
| Query (top-5) | ~5ms | ~30ms |
| Update | ~10ms | ~50ms |
| Delete | ~5ms | ~20ms |

---

### 2. FAISS (Alternativa para alta performance)

**GitHub**: https://github.com/facebookresearch/faiss
**Licença**: MIT
**Instalação**: `pip install faiss-cpu` (ou `faiss-gpu`)

```python
import faiss
import numpy as np

# Criar índice
dimension = 384  # MiniLM embeddings
index = faiss.IndexFlatIP(dimension)  # Inner product (cosine se normalizado)

# Adicionar embeddings
embeddings = np.random.random((1000, dimension)).astype('float32')
index.add(embeddings)

# Buscar
query = np.random.random((1, dimension)).astype('float32')
distances, indices = index.search(query, k=5)
```

**Vantagens:**
- Mais rápido que ChromaDB para grandes volumes
- Suporta GPU
- Muitos tipos de índice (IVF, HNSW, PQ)

**Desvantagens:**
- Sem CRUD completo
- Sem persistência automática
- Sem metadata filtering
- Mais complexo de usar

---

### 3. sqlite-vec (Alternativa leve)

**GitHub**: https://github.com/alexgarcia/sqlite-vec
**Licença**: MIT/Apache 2.0
**Instalação**: `pip install sqlite-vec`

```python
import sqlite3
import sqlite_vec

db = sqlite3.connect(":memory:")
db.enable_load_extension(True)
sqlite_vec.load(db)

# Criar tabela
db.execute("""
    CREATE VEC_TABLE documents (
        id INTEGER PRIMARY KEY,
        content TEXT,
        embedding FLOAT[384]
    )
""")

# Inserir
import numpy as np
embedding = np.random.random(384).astype('float32')
db.execute(
    "INSERT INTO documents (content, embedding) VALUES (?, ?)",
    ("O usuário prefere TypeScript", embedding.tobytes())
)

# Buscar KNN
query_emb = np.random.random(384).astype('float32')
results = db.execute("""
    SELECT id, content, distance
    FROM documents
    WHERE embedding MATCH ? AND k=5
    ORDER BY distance
""", (query_emb.tobytes(),)).fetchall()
```

**Vantagens:**
- Extremamente leve (~100KB)
- Roda em qualquer lugar (SQLite)
- Sem dependências externas

**Desvantagens:**
- Sem CRUD completo
- Sem metadata filtering
- Brute force (sem HNSW)

---

### 4. Qdrant (Alternativa production)

**Website**: https://qdrant.tech/
**Licença**: Apache 2.0
**Instalação**: Docker ou binário

```python
from qdrant_client import QdrantClient
from qdrant_client.models import VectorParams, Distance, PointStruct

client = QdrantClient(":memory:")  # ou localhost:6333

client.create_collection(
    collection_name="facts",
    vectors_config=VectorParams(size=384, distance=Distance.COSINE)
)

client.upsert(
    collection_name="facts",
    points=[
        PointStruct(id=1, vector=[...], payload={"type": "preference"})
    ]
)
```

**Vantagens:**
- Production-ready
- HNSW nativo
- Filtragem rica
- Multi-tenancy

**Desvantagens:**
- Precisa de servidor (Docker)
- Mais pesado que ChromaDB

---

## Decisão: ChromaDB

### Comparação

| Critério | ChromaDB | FAISS | sqlite-vec | Qdrant |
|----------|----------|-------|------------|--------|
| Setup | ⚡ Zero config | ⚡ Biblioteca | ⚡ Zero config | 🐌 Docker |
| CRUD | ✅ Completo | ❌ Limitado | ❌ Limitado | ✅ Completo |
| Persistência | ✅ Automática | ❌ Manual | ✅ SQLite | ✅ Automática |
| Metadata filter | ✅ Sim | ❌ Não | ❌ Não | ✅ Sim |
| Performance (1M) | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Memória | Baixa | Alta | Muito baixa | Média |
| Produção | Médio | Precisa build | Pequeno | Excelente |

Para o plugin de memória:
- Até ~50K memórias (razoável para uso individual)
- ChromaDB é perfeito: zero config, persistente, CRUD completo
- Se precisar escalar以后, pode migrar para Qdrant

---

## Estrutura de Collections

```
.opencode/memory/
├── facts/
│   ├── embeddings/     # Vetores 384-dim
│   ├── documents/      # Textos originais
│   └── metadata/       # Type, importance, timestamp
├── conversations/
│   ├── embeddings/
│   ├── documents/
│   └── metadata/
└── decisions/
    ├── embeddings/
    ├── documents/
    └── metadata/
```

### Schema de Metadata

```python
{
    "sessionID": "ses_abc123",
    "timestamp": 1695302400000,  # Unix ms
    "type": "preference",         # Classificado pelo Laya
    "importance": "alta",
    "project": "/home/user/myapp",
    "tags": ["typescript", "frontend"],
    "source": "user",             # user | assistant | system
    "version": 1                  # Para updates
}
```

---

## Operações CRUD

### Create (Store)

```python
def store_memory(collection, text, metadata, embedder):
    embedding = embedder.encode(text)
    memory_id = f"mem_{uuid.uuid4().hex[:12]}"
    collection.add(
        documents=[text],
        embeddings=[embedding.tolist()],
        metadatas=[metadata],
        ids=[memory_id]
    )
    return memory_id
```

### Read (Recall)

```python
def recall_memories(collection, query, embedder, top_k=20):
    query_embedding = embedder.encode(f"query: {query}")
    results = collection.query(
        query_embeddings=[query_embedding.tolist()],
        n_results=top_k
    )
    return results
```

### Update

```python
def update_memory(collection, memory_id, text=None, metadata=None, embedder=None):
    update_kwargs = {"ids": [memory_id]}
    if text and embedder:
        update_kwargs["documents"] = [text]
        update_kwargs["embeddings"] = [embedder.encode(text).tolist()]
    if metadata:
        update_kwargs["metadatas"] = [metadata]
    collection.update(**update_kwargs)
```

### Delete

```python
def delete_memory(collection, memory_id):
    collection.delete(ids=[memory_id])
```

---

## Fontes

- **ChromaDB**: https://www.trychroma.com/
- **FAISS**: https://github.com/facebookresearch/faiss
- **sqlite-vec**: https://github.com/alexgarcia/sqlite-vec
- **Qdrant**: https://qdrant.tech/
- **Comparação**: https://www.local-llm.net/compare/chromadb-vs-qdrant-vs-faiss-vs-pgvector/
