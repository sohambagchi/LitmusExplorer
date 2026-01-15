import {
  DEFAULT_MEMORY_ORDERS,
  DEFAULT_RELATION_TYPES,
  type SessionModelConfig,
} from "../types";

export const DEFAULT_MODEL_CONFIG: SessionModelConfig = {
  relationTypes: [...DEFAULT_RELATION_TYPES],
  memoryOrders: [...DEFAULT_MEMORY_ORDERS],
};

