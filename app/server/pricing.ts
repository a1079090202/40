import {
  LIGHT_FEE_CENTS,
  COURT_FEE_CENTS,
  LIGHT_FROM,
  type CourtType,
} from "./config";
import { timeOf } from "./time";

export interface PriceBreakdown {
  slotCount: number;
  courtFeeCents: number; // 场租合计
  lightFeeCents: number; // 灯光费合计
  totalCents: number;
}

/** 某个半小时格是否落在开灯时段（格子起点 >= LIGHT_FROM） */
export function slotHasLight(slot: string): boolean {
  return timeOf(slot) >= LIGHT_FROM;
}

/**
 * 按占用的半小时格计费。
 * 场租：每格 COURT_FEE_CENTS；灯光费：晚场格每格 LIGHT_FEE_CENTS。
 * 灯光费在核销时入账，下单冻结时按同样口径预估。
 */
export function priceSlots(courtType: CourtType, slots: string[]): PriceBreakdown {
  let courtFeeCents = 0;
  let lightFeeCents = 0;
  for (const slot of slots) {
    courtFeeCents += COURT_FEE_CENTS[courtType];
    if (slotHasLight(slot)) lightFeeCents += LIGHT_FEE_CENTS[courtType];
  }
  return {
    slotCount: slots.length,
    courtFeeCents,
    lightFeeCents,
    totalCents: courtFeeCents + lightFeeCents,
  };
}

export function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}
