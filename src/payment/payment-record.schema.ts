import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';
import { PaymentChannel } from './payment.types';

export type PaymentRecordDocument = PaymentRecord & Document;

export enum PaymentRecordStatus {
  // 待支付
  PENDING = 'pending',
  // 处理中，防止重复发货
  PROCESSING = 'processing',
  // 支付成功
  SUCCESS = 'success',
  // 支付失败
  FAILED = 'failed',
}

@Schema({ timestamps: true })
export class PaymentRecord {
  @Prop({ required: true, unique: true })
  orderId: string; // 订单号（唯一）

  @Prop({ required: true, enum: PaymentChannel })
  channel: PaymentChannel; // 支付渠道（支付宝或微信）

  @Prop({ required: true })
  amount: number; // 支付金额（元）

  @Prop({ default: 'CNY' })
  currency: string; // 货币类型

  @Prop()
  planId?: string; // 套餐ID（single, pro, max, ultra, custom）

  @Prop()
  planName?: string; // 套餐名称

  @Prop()
  source?: string; // 订单来源

  @Prop()
  description?: string; // 订单描述

  @Prop({ type: SchemaTypes.Mixed })
  metadata?: Record<string, any>; // 灵活的元数据存储

  @Prop({ type: SchemaTypes.Mixed })
  notificationPayload?: Record<string, any>; // 支付通知的原始负载

  @Prop({ enum: PaymentRecordStatus, default: PaymentRecordStatus.PENDING })
  status: PaymentRecordStatus; // 订单状态

  @Prop()
  paidAt?: Date; // 支付完成时间

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', index: true })
  user?: Types.ObjectId; // 用户ID引用

  @Prop()
  userIdentifier?: string; // 用户标识符

  @Prop({ index: true })
  userId?: string; // 用户ID（索引）

  @Prop()
  processingAt?: Date; // 开始处理时间

  @Prop()
  createdAt?: Date; // 创建时间
}

export const PaymentRecordSchema = SchemaFactory.createForClass(PaymentRecord);
