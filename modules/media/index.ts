// ================================================================
// modules/media — Inbound Media 适配器 + 抽象层
// ================================================================
// 架构概览：
//
//   ┌──────────────────────────────────────────────┐
//   │        InboundMediaResolver (编排层)          │
//   │  下载 → 存储 → 分类 → 生成 Agent 提示         │
//   └──────┬───────────────────────┬────────────────┘
//          │                       │
//          ▼                       ▼
//   ┌──────────────┐      ┌──────────────┐
//   │InboundMedia  │      │  MediaStore  │
//   │Adapter (接口)│      │  (存储层)     │
//   └──────┬───────┘      └──────────────┘
//          │
//   ┌──────▼───────┐
//   │FeishuInbound │     (未来: TelegramInboundAdapter, ...)
//   │Adapter       │
//   └──────────────┘
// ================================================================

export * from './types';
export { MediaStore, sniffMimeFromBuffer, mimeFromFileName, extensionForMime, categorizeMedia } from './media-store';
export { InboundMediaResolver } from './resolver';
export { FeishuInboundAdapter } from './feishu-inbound-adapter';
export { TelegramInboundAdapter } from './telegram-inbound-adapter';
