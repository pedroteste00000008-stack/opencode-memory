# Pesquisa: Laya — Motor de Decisão

## O que é o Laya?

O Laya é um modelo de decisão open-source (Apache 2.0) desenvolvido pela [Convai Innovations](https://github.com/NandhaKishorM/laya). É uma alternativa open-source ao Jev da TypeSafe AI.

### Diferencial Fundamental

Enquanto LLMs **geram texto** token por token, o Laya **nunca gera texto**. Ele recebe:
- Um **estado** (texto, email, ticket, JSON)
- **Perguntas tipadas** com tipos definidos (choice, score, noul)

E retorna:
- **Respostas tipadas** com probabilidades calibradas
- **Scores de confiança** matematicamente calibrados

Isso elimina:
- Erros de parsing (não precisa extrair JSON de texto)
- Alucinações (não gera conteúdo)
- Latência de geração (~33ms vs ~500ms+)

---

## Checkpoints Disponíveis

| Checkpoint | Encoder | Params | Context | Melhor para |
|-----------|---------|--------|---------|-------------|
| `convaiinnovations/laya` | ModernBERT-large | 421M | 512 | Inglês, geral, guardrails |
| `convaiinnovations/laya-multilingual` | mmBERT-base | 322M | 1024 | 100+ idiomas, ~2.2x mais rápido |
| `convaiinnovations/laya-typed-decisions` | ModernBERT-large | 421M | 1024 | 4 workflows de decisão |

### Para o plugin de memória

Recomendamos o checkpoint **`convaiinnovations/laya`** (English root) porque:
- Nossas memórias serão主要emente em português/inglês
- 512 tokens de contexto é suficiente para classificar trechos de conversa
- É o checkpoint mais testado e estável

---

## Tipos de Perguntas (Primitives)

### 1. `choice` — Escolha entre opções

```python
{
    "type": "choice",
    "instructions": "Que tipo de informação é este trecho?",
    "criteria": {
        "decision": "Decisão técnica ou de design",
        "preference": "Preferência pessoal do usuário",
        "fact": "Fato sobre o projeto ou código",
        "code": "Trecho de código ou instrução de implementação"
    }
}
```

**Retorna**: A chave escolhida + distribuição de probabilidade

### 2. `score` — Escala ordinal

```python
{
    "type": "score",
    "instructions": "Quão importante é esta informação para longo prazo?",
    "criteria": ["não importante", "pouco importante", "moderadamente importante", "importante", "muito importante"]
}
```

**Retorna**: Índice escolhido + distribuição de probabilidade

### 3. `noul` — Verdadeiro/Falso calibrado

```python
{
    "type": "noul",
    "instructions": "Esta memória ainda é válida e relevante?",
    "criteria": {
        "true": "A informação ainda está correta e relevante",
        "false": "A informação está obsoleta ou incorreta"
    }
}
```

**Retorna**: true/false + probabilidade calibrada

---

## Performance

### Benchmarks publicados

| Métrica | Laya (routed) | TypeSafe Jev 1.13.0 |
|---------|---------------|---------------------|
| Latência p50 (1 pergunta) | **32.8 ms** | 236-276 ms |
| Throughput (batch 10) | 156.0 ms | ~1,500 ms |
| Throughput (batch 50) | 721.4 ms | Multi-second |
| Acurácia (typed-decisions) | **0.766** | 0.727 |
| ECE (calibração) | **0.081** | 0.246 |

### No nosso contexto

Para classificar memórias, esperamos:
- **Latência por classificação**: ~33ms (1 pergunta)
- **Batch de 10 memórias**: ~150ms
- **Classificação de 50 memórias**: ~700ms

Isso é aceitável porque a classificação acontece:
- **Store**: Async, não bloqueia a resposta
- **Recall**: Uma vez por query, antes de injetar contexto
- **Prune**: Roda em background, periódico

---

## Uso no Plugin de Memória

### 1. Classificação na Armazenamento

```python
import laya

agent = laya.load("convaiinnovations/laya")

def classify_memory(text: str) -> dict:
    result = agent.predict(
        {"text": text},
        {
            "memory_type": {
                "type": "choice",
                "instructions": "Classifique o tipo de informação nesta memória:",
                "criteria": {
                    "decision": "Decisão técnica: escolha entre alternativas",
                    "preference": "Preferência do usuário: gosto, config, workflow",
                    "fact": "Fato: informação objetiva sobre código/projeto",
                    "pattern": "Padrão: comportamento recorrente notado"
                }
            },
            "importance": {
                "type": "score",
                "instructions": "Quão importante é esta informação para sessões futuras?",
                "criteria": [
                    "descartável — não precisa guardar",
                    "baixa — pode ser útil mas não essencial",
                    "média — útil para evitar repetição",
                    "alta — essencial para continuidade",
                    "crítica — preferência ou decisão fundamental"
                ]
            },
            "should_store": {
                "type": "noul",
                "instructions": "Vale a pena armazenar esta informação como memória de longo prazo?",
                "criteria": {
                    "true": "Contém informação reutilizável ou importante",
                    "false": "É genérica, temporária ou ruído"
                }
            }
        }
    )
    return {
        "type": result["memory_type"],
        "importance": result["importance"],
        "should_store": result["should_store"]
    }
```

### 2. Filtragem na Recuperação

```python
def filter_retrieved(query: str, memories: list[dict]) -> list[dict]:
    """Filtra memórias recuperadas usando Laya."""
    filtered = []
    for mem in memories:
        result = agent.predict(
            {"text": mem["content"], "query": query},
            {
                "relevance": {
                    "type": "noul",
                    "instructions": f"Esta memória é relevante para a pergunta: '{query}'?",
                    "criteria": {
                        "true": "A memória ajuda a responder a pergunta",
                        "false": "A memória não é relevante para esta pergunta"
                    }
                },
                "obsolete": {
                    "type": "noul",
                    "instructions": "Esta informação pode estar obsoleta ou ter sido substituída?",
                    "criteria": {
                        "true": "Pode estar desatualizada",
                        "false": "Provavelmente ainda está correta"
                    }
                }
            }
        )
        if result["relevance"] and not result["obsolete"]:
            filtered.append(mem)
    return filtered
```

### 3. Revisão periódica (Prune)

```python
def review_memory(memory: dict) -> dict:
    """Revisa uma memória antiga."""
    result = agent.predict(
        {"text": memory["content"], "age_days": memory["age_days"]},
        {
            "still_valid": {
                "type": "noul",
                "instructions": "Esta memória ainda reflete a realidade atual?",
                "criteria": {
                    "true": "A informação ainda está correta",
                    "false": "A informação está obsoleta ou incorreta"
                }
            },
            "new_importance": {
                "type": "score",
                "instructions": "Considerando a idade, qual a importância atual?",
                "criteria": ["descartável", "baixa", "média", "alta"]
            }
        }
    )
    return result
```

---

## Instalação e Configuração

### Instalar

```bash
pip install laya
```

### Carregar modelo

```python
import laya

# English root (recomendado para o plugin)
agent = laya.load("convaiinnovations/laya")

# Multilingual (se precisar de suporte a PT nativo)
agent_ml = laya.load("convaiinnovations/laya", subfolder="multilingual")

# Typed decisions (para workflows específicos)
agent_td = laya.load("convaiinnovations/laya", subfolder="typed-decisions")
```

### Router (multi-checkpoint)

```python
from laya import Router

router = Router()
result = router.predict(state, questions)
# Detecta idioma e escolhe checkpoint automaticamente
```

---

## Limitações

| Limitação | Impacto | Mitigação |
|-----------|---------|-----------|
| Max 512 tokens (English) | Memórias longas precisam ser truncadas | Chunking antes de classificar |
| 77+ opções de choice | Acurácia cai (orçamento de tokens por opção) | Manter <20 opções por pergunta |
| Zero-shot fraco (~0.36) | Precisa de fine-tuning para workflows específicos | Usar Router ou fine-tunar |
| ECE alto antes de temp. scaling | Calibração precisa de ajuste | Temperature fitting por tipo |
| Inglês primário | PT pode ter qualidade menor | Usar checkpoint multilingual |

---

## Fontes

- **GitHub**: https://github.com/NandhaKishorM/laya
- **PyPI**: https://pypi.org/project/laya/
- **HuggingFace**: https://huggingface.co/convaiinnovations/laya
- **Docs**: https://laya.convaiinnovations.com/
- **Artigo iMasters**: https://imasters.com.br/noticia/laya-chega-como-alternativa-open-source-ao-jev-da-typesafe-ai
