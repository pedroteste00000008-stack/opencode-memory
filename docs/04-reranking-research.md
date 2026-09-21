# Pesquisa: Reranking

## O que é Reranking?

Reranking é a segunda etapa de um pipeline de retrieval. Após recuperar candidatos rapidamente com embeddings (bi-encoder), o reranker reavalia cada par (query, documento) com um modelo mais preciso (cross-encoder) e reordena os resultados.

```
Pipeline Retrieve → Rerank:

1. Query: "qual banco de dados usar?"
2. Embedding search (top-20 candidatos)     ← rápido, ~10ms
3. Rerank cross-encoder (20 → top-5)        ← preciso, ~100ms
4. Retornar top-5 relevantes
```

### Por que não usar só embeddings?

| Abordagem | Velocidade | Precisão |
|-----------|-----------|----------|
| Bi-encoder (embeddings) | ⚡⚡⚡ Muito rápido | ⭐⭐ Boa |
| Cross-encoder (reranker) | ⚡ Lento | ⭐⭐⭐⭐ Excelente |

O cross-encoder vê query + documento juntos, capturando relações que o bi-encoder perde ao encoding separadamente.

---

## Opções Avaliadas

### 1. FlashRank (Recomendado ✅)

**GitHub**: https://github.com/PrithivirajDamodaran/FlashRank
**Licença**: Apache 2.0
**Instalação**: `pip install flashrank`

#### Modelos disponíveis

| Modelo | Tamanho | Velocidade | Qualidade | Notas |
|--------|---------|------------|-----------|-------|
| `ms-marco-TinyBERT-L-2-v2` | ~4MB | ⚡⚡⚡ Ultra rápido | ⭐⭐ Boa | Default, menor do mundo |
| `ms-marco-MiniLM-L-12-v2` | ~34MB | ⚡⚡ Rápido | ⭐⭐⭐⭐ Melhor | **Recomendado** |
| `rank-T5-flan` | ~110MB | ⚡ Médio | ⭐⭐⭐⭐⭐ Top zero-shot | Melhor sem fine-tuning |
| `ms-marco-MultiBERT-L-12` | ~150MB | 🐌 Lento | ⭐⭐⭐⭐ Multilingual | 100+ idiomas |

#### Por que FlashRank?

```
✅ Não precisa de PyTorch/Transformers (usa ONNX internamente)
✅ ~34MB para MiniLM-L-12 (maior qualidade vs tamanho)
✅ Reranking em <100ms para 50 candidatos em CPU
✅ pip install flashrank — sem dependências pesadas
✅ Competitivo com cross-encoders que precisam de PyTorch
✅ Suporta batch processing
```

#### Código de uso

```python
from flashrank import Ranker, RerankRequest

# Inicializar (baixa modelo na primeira vez)
ranker = Ranker(
    model_name="ms-marco-MiniLM-L-12-v2",
    max_length=512  # Ajustar ao tamanho dos documentos
)

# Criar request
rerank_request = RerankRequest(
    query="qual banco de dados o usuário prefere?",
    passages=[
        {"id": 1, "text": "O usuário decidiu usar PostgreSQL para o projeto"},
        {"id": 2, "text": "React é uma biblioteca JavaScript para UI"},
        {"id": 3, "text": "O usuário gosta de bancos relacionais"},
        {"id": 4, "text": "TypeScript é uma linguagem tipada"},
    ]
)

# Rerank
results = ranker.rerank(rerank_request)

# Resultado ordenado por relevância
for r in results:
    print(f"ID: {r['id']}, Score: {r['score']}, Text: {r['text'][:50]}...")

# Output esperado:
# ID: 1, Score: 0.92, Text: O usuário decidiu usar PostgreSQL para o projeto...
# ID: 3, Score: 0.85, Text: O usuário gosta de bancos relacionais...
# ID: 4, Score: 0.12, Text: TypeScript é uma linguagem tipada...
# ID: 2, Score: 0.05, Text: React é uma biblioteca JavaScript para UI...
```

#### Ajuste de max_length

```python
# Para documentos curtos (chat messages, <100 tokens)
ranker = Ranker(max_length=128)

# Para documentos médios (resumos, <300 tokens)
ranker = Ranker(max_length=256)

# Para documentos longos (artigos, <500 tokens)
ranker = Ranker(max_length=512)

# ⚠️ max_length maior = mais lento
# Ajustar ao tamanho real dos documentos para melhor performance
```

---

### 2. Sentence Transformers CrossEncoder

**Website**: https://www.sbert.net/
**Licença**: Apache 2.0
**Instalação**: `pip install sentence-transformers`

```python
from sentence_transformers import CrossEncoder

# Carregar modelo
cross_encoder = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")

# Criar pares query-documento
pairs = [
    ["qual banco de dados usar?", "O usuário decidiu usar PostgreSQL"],
    ["qual banco de dados usar?", "React é uma biblioteca para UI"],
]

# Predizer scores
scores = cross_encoder.predict(pairs)
# array([0.92, 0.05])

# Rerank
ranked = sorted(zip(scores, pairs), key=lambda x: x[0], reverse=True)
```

**Vantagens:**
- Mais modelos disponíveis
- Integração direta com sentence-transformers
- Suporta fine-tuning

**Desvantagens:**
- Precisa de PyTorch (~2GB)
- Mais lento que FlashRank
- Mais memória

---

### 3. KaLM-Reranker (Alternativa nova)

**HuggingFace**: https://huggingface.co/KaLM-Embedding/KaLM-Reranker-V1-Nano

```python
from sentence_transformers import CrossEncoder

model = CrossEncoder(
    "KaLM-Embedding/KaLM-Reranker-V1-Nano",
    trust_remote_code=True,
    device="cpu",
    model_kwargs={"chunk_size": 4},
)

pairs = [("query", "document")]
scores = model.predict(pairs)
```

**Vantagens:**
- Encoder-decoder com compressão
- competitive performance
- Suporta prompts customizados

**Desvantagens:**
- Mais complexo de configurar
- Precisa de trust_remote_code

---

## Decisão: FlashRank `ms-marco-MiniLM-L-12-v2`

### Benchmark comparativo

| Biblioteca | Modelo | Tamanho | Tempo (50 pares) | Precisão |
|-----------|--------|---------|------------------|----------|
| FlashRank | MiniLM-L-12 | 34MB | ~80ms | ⭐⭐⭐⭐ |
| FlashRank | TinyBERT-L-2 | 4MB | ~30ms | ⭐⭐⭐ |
| ST CrossEncoder | MiniLM-L-6 | 80MB | ~150ms | ⭐⭐⭐⭐ |
| ST CrossEncoder | MiniLM-L-12 | 120MB | ~250ms | ⭐⭐⭐⭐⭐ |

FlashRank MiniLM-L-12 oferece:
- Melhor balance entre tamanho e qualidade
- 2x mais rápido que ST CrossEncoder
- 65% menos memória que ST CrossEncoder

---

## Integração no Pipeline

### Pseudocódigo do pipeline completo

```python
def retrieve_and_rerank(query: str, collection, embedder, ranker, top_k=5):
    # 1. Embedding da query
    query_embedding = embedder.encode(f"query: {query}")

    # 2. Busca vetorial (top-20 candidatos)
    results = collection.query(
        query_embeddings=[query_embedding.tolist()],
        n_results=20
    )

    # 3. Preparar para rerank
    passages = [
        {"id": i, "text": doc}
        for i, (doc, meta) in enumerate(zip(
            results["documents"][0],
            results["metadatas"][0]
        ))
    ]

    # 4. Rerank
    rerank_request = RerankRequest(query=query, passages=passages)
    reranked = ranker.rerank(rerank_request)

    # 5. Retornar top-K
    return reranked[:top_k]
```

### Performance esperada

| Etapa | Latência | CPU Usage |
|-------|----------|-----------|
| Embedding query | ~15ms | Baixo |
| ChromaDB search (top-20) | ~10ms | Baixo |
| FlashRank rerank (20→5) | ~80ms | Médio |
| Laya filter | ~33ms | Baixo |
| **Total** | **~138ms** | **Baixo-Médio** |

---

## Ajustes de Performance

### 1. Ajustar max_length

```python
# Medir tamanho médio dos documentos
avg_tokens = mean([len(doc.split()) for doc in documents])

# Ajustar max_length
if avg_tokens < 100:
    ranker = Ranker(max_length=128)
elif avg_tokens < 300:
    ranker = Ranker(max_length=256)
else:
    ranker = Ranker(max_length=512)
```

### 2. Batch processing

```python
# Para múltiplas queries
queries = ["query1", "query2", "query3"]
all_candidates = [...]

for q, candidates in zip(queries, all_candidates):
    request = RerankRequest(query=q, passages=candidates)
    results = ranker.rerank(request)
```

### 3. Cache de documentos

```python
# Cache de documentos que já foram rerankeados
from functools import lru_cache

@lru_cache(maxsize=1000)
def cached_rerank(query: str, doc_ids: tuple):
    # Só rerankeia se query ou documentos mudaram
    pass
```

---

## Fontes

- **FlashRank**: https://github.com/PrithivirajDamodaran/FlashRank
- **Sentence Transformers CrossEncoder**: https://www.sbert.net/examples/applications/cross-encoder/README.html
- **KaLM-Reranker**: https://huggingface.co/KaLM-Embedding/KaLM-Reranker-V1-Nano
- **Cross-Encoder vs Bi-Encoder**: https://www.sbert.net/examples/applications/cross-encoder/README.html
- **Reranking Guide**: https://mljourney.com/how-to-implement-cross-encoder-reranking-in-your-rag-pipeline/
