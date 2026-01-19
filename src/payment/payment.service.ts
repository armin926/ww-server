import { Injectable } from '@nestjs/common';
import { PaymentOrderPayload, PaymentInitiationResult } from './payment.types';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';

@Injectable()
export class PaymentService {
  constructor() {}

  /**
   * 创建支付订单
   * @param dto 支付订单信息
   * @returns 支付订单结果
   */
  async initiatePayment(
    dto: InitiatePaymentDto,
    user?: { userId?: string },
  ): Promise<PaymentInitiationResult> {}

  /**
   * 主动查询支付宝支付结果
   * @param orderId 订单ID
   * @param user 当前用户信息
   * @returns 支付结果
   */
  async queryAlipayPaymentStatus(orderId: string, user: { userId: string }) {}

  /**
   * 主动查询微信支付结果
   * @param orderId 订单ID
   * @param user 当前用户信息
   * @returns 支付结果
   */
  async queryWechatPaymentStatus(orderId: string, user: { userId: string }) {}
}
