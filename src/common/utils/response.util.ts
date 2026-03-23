import { HttpStatus } from '@nestjs/common';

export class ResponseUtil {
  static success<T = unknown>(
    data: T,
    message: string = '操作成功',
    code: number = HttpStatus.OK,
  ) {
    return {
      code,
      message,
      data,
      timestamp: new Date().toISOString(),
    };
  }
  static error(
    message: string = '操作失败',
    code: number = HttpStatus.BAD_REQUEST,
    data: unknown = null,
  ) {
    return {
      code,
      message,
      data,
      timeStamp: new Date().toISOString(),
    };
  }
  static paginated<T = unknown>(
    data: T[],
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    },
    message: string = '查询成功',
    code: number = HttpStatus.OK,
  ) {
    return {
      code,
      message,
      data,
      pagination,
      timestamp: new Date().toISOString(),
    };
  }
  static list<T = unknown>(
    data: T[],
    message: string = '查询成功',
    code: number = HttpStatus.OK,
  ) {
    return {
      code,
      message,
      data,
      timestamp: new Date().toISOString(),
    };
  }
  static empty(message: string = '暂无数据', code: number = HttpStatus.OK) {
    return {
      code,
      message,
      data: null,
      timestamp: new Date().toISOString(),
    };
  }
}
