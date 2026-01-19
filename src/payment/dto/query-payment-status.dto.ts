import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class QueryPaymentStatusDto {
  @IsString()
  @ApiProperty({ description: '订单ID', required: true })
  orderId: string;

  @IsIn(['alipay', 'wechat'])
  @ApiProperty({ description: '支付渠道', required: true })
  channel: string;
}
