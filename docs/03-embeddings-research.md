# Pesquisa: Embeddings Semânticos

## O que são Embeddings?

Embeddings são representações vetoriais de texto em espaço dimensional denso. Textos semanticamente similares ficam próximos no espaço vetorial, permitindo busca por similaridade.

**Exemplo:**
- "O usuário prefere TypeScript" → [0.12, -0.34, 0.56, ...] (384 dims)
- "Gosto de usar TS" → [0.11, -0.33, 0.55, ...] (muito próximo)
- "Hoje está chovendo" → [-0.78, 0.45, -0.12, ...] (distante)

---

## Opções Avaliadas

### 1. Sentence Transformers (Recomendado ✅)

**Website**: https://www.sbert.net/
**Licença**: Apache 2.0
**Instalação**: `pip install sentence-transformers`

#### Modelos avaliados

| Modelo | Params | Dims | Velocidade | Qualidade | Uso |
|--------|--------|------|------------|-----------|-----|
| `all-MiniLM-L6-v2` | 22M | 384 | ⚡⚡⚡ Muito rápido | ⭐⭐⭐ Boa | **Recomendado** |
| `all-mpnet-base-v2` | 110M | 768 | ⚡⚡ Rápido | ⭐⭐⭐⭐ Excelente | Se precisar mais qualidade |
| `EmbeddingGemma-300m` | 300M | 768 | ⚡ Médio | ⭐⭐⭐⭐ Excelente | Modelo 2026, bom custo-benefício |
| `BGE-M3` | 568M | 1024 | 🐌 Lento | ⭐⭐⭐⭐⭐ Top | Multilingual production |
| `Qwen3-Embedding` | 0.6-8B | até 4096 | 🐌🐌 Muito lento | ⭐⭐⭐⭐⭐ Frontier | GPU necessária |

#### Por que `all-MiniLM-L6-v2`?

```
✅ 22MB — cabe em qualquer ambiente
✅ 384 dimensões — suficiente para memória de conversa
✅ ~14ms por 1K tokens em CPU
✅ ~14,700 frases/segundo em CPU
✅ Funciona bem para textos curtos/médios (chat messages)
✅ Comunidade massiva, bem testado
✅ Suporta ONNX/OpenVINO para aceleração
```

#### Código de uso

```python
from sentence_transformers import SentenceTransformer

# Carregar modelo (baixa na primeira vez, cacheia)
embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

# Embedding de documento
doc_embedding = embedder.encode("O usuário prefere TypeScript sobre JavaScript")
# Shape: (384,)

# Embedding de query (com prefixo para modelos treinados para retrieval)
query_embedding = embedder.encode("query: qual a linguagem preferida?")
# Shape: (384,)

# Batch embedding
texts = ["Doc 1", "Doc 2", "Doc 3"]
embeddings = embedder.encode(texts, batch_size=32, show_progress_bar=True)
# Shape: (3, 384)

# Similaridade cosine
from sentence_transformers.util import cos_sim
similarity = cos_sim(query_embedding, doc_embedding)
# tensor([[0.85]])
```

#### Aceleração com ONNX

```python
# Para CPU mais rápido
embedder = SentenceTransformer(
    "sentence-transformers/all-MiniLM-L6-v2",
    backend="onnx"  # ou "openvino"
)
# 2-3x mais rápido em CPU
```

---

### 2. FastEmbed (Alternativa leve)

**Website**: https://github.com/qdrant/fastembed
**Licença**: Apache 2.0
**Instalação**: `pip install fastembed`

```python
from fastembed import TextEmbedding

model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
embeddings = list(model.embed(["text1", "text2"]))
```

**Vantagens:**
- Não precisa de PyTorch (usa ONNX Runtime)
- Mais leve que sentence-transformers
- Suporta sparse embeddings e ColBERT

**Desvantagens:**
- Menos modelos disponíveis
- Ecossistema menor

---

### 3. Nomic Embed (Alternativa 2026)

**Website**: https://huggingface.co/nomic-ai/nomic-embed-text-v1
**Parâmetros**: ~137M
**Dims**: 768 (suporta Matryoshka — pode reduzir)

```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("nomic-ai/nomic-embed-text-v1", trust_remote_code=True)
embeddings = model.encode(["text1"], show_progress_bar=True)
```

**Vantagens:**
- Melhor qualidade que MiniLM
- Suporta dimensões variáveis (Matryoshka)
- Treinado em 1.6B pares contrastivos

**Desvantagens:**
- ~2x mais lento que MiniLM
- ~100MB vs 22MB

---

## Decisão: `all-MiniLM-L6-v2`

### Benchmark comparativo (iệu quả real)

| Modelo | Tempo embed (1K tokens) | Latência query | Acurácia top-5 | RAM |
|--------|------------------------|----------------|-----------------|-----|
| MiniLM-L6-v2 | 14.7ms | 68ms | 80.7% | ~100MB |
| E5-Base-v2 | 38.2ms | 79ms | 83.2% | ~400MB |
| BGE-Base-v1.5 | 41.5ms | 82ms | 84.7% | ~400MB |
| Nomic Embed v1 | 72.1ms | 104ms | 86.2% | ~500MB |

Para memórias de conversa (textos curtos, ~50-200 tokens), MiniLM é ideal:
- Velocidade é mais importante que qualidade marginal
- 80.7% de acurácia é suficiente para recall
- O reranker (FlashRank) compensa a diferença na segunda etapa

---

## Integração com ChromaDB

ChromaDB pode usar Sentence Transformers como embedding function:

```python
import chromadb
from sentence_transformers import SentenceTransformer

# Configurar embedding function customizada
class MiniLMEmbeddingFunction:
    def __init__(self):
        self.model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

    def __call__(self, input: list[str]) -> list[list[float]]:
        embeddings = self.model.encode(input)
        return embeddings.tolist()

# Usar com ChromaDB
ef = MiniLMEmbeddingFunction()
client = chromadb.PersistentClient(path="./memory")
collection = client.get_or_create_collection(
    "facts",
    embedding_function=ef  # ChromaDB usa automaticamente
)

# Agora pode adicionar documentos sem embeddings pré-computados
collection.add(
    documents=["O usuário prefere TypeScript"],
    metadatas=[{"type": "preference"}],
    ids=["mem_001"]
)

# Busca automática com embedding
results = collection.query(
    query_texts=["qual linguagem o usuário gosta?"],
    n_results=5
)
```

---

## Chunking Strategy

Para memórias de conversa, precisamos decidir como dividir o texto:

### Opção 1: Mensagem inteira (recomendado para chat)

```python
# Cada mensagem do usuário/assistente = 1 memória
# Good para: conversas curtas, decisões pontuais
# Bad para: discussões longas e complexas
```

### Opção 2: Sliding window

```python
# Janela de N tokens com overlap de M tokens
# Good para: textos longos
# Bad para: pode quebrar contexto
```

### Opção 3: Por seção/tópico

```python
# Detectar mudanças de tópico e dividir
# Good para: conversas com múltiplos tópicos
# Bad para: precisa de detector de tópico
```

### Recomendação

Para o plugin de memória, usar **Opção 1 (mensagem inteira)** com limite de 512 tokens:
- Chat messages são tipicamente <200 tokens
- Laya tem contexto de 512 tokens
- Evita perda de contexto por chunking

---

## Métricas de similaridade

### Cosine Similarity (recomendado)

```python
import numpy as np

def cosine_similarity(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

# Range: -1 a 1 (1 = idêntico, 0 = sem relação, -1 = oposto)
# ChromaDB usa cosine por padrão
```

### Dot Product

```python
# Mais rápido que cosine
# Funciona bem se embeddings são normalizados
# ChromaDB suporta via configuração
```

### L2 (Euclidean)

```python
# Distância euclidiana
# Menos intuitivo para similaridade semântica
# Não recomendado para embeddings de texto
```

---

## Fontes

- **Sentence Transformers**: https://www.sbert.net/
- **MTEB Leaderboard**: https://huggingface.co/spaces/mteb/leaderboard
- **FastEmbed**: https://github.com/qdrant/fastembed
- **BentoML Embedding Guide**: https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models
- **Benchmark comparativo**: https://supermemory.ai/blog/best-open-source-embedding-models-benchmarked-and-ranked/
