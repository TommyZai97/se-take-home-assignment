import { Logger } from "../utils/logger";
import {
  BOT_STATUS,
  Bot,
  Order,
  ORDER_STATUS,
  ORDER_TYPES,
  OrderStats,
  OrderType,
} from "../domain/types";

interface AssignOptions {
  announceIdleForBots?: Bot[];
}

export class OrderController {
  private currentTime = 0;
  private nextOrderId = 1001;
  private nextBotId = 1;

  private readonly orders: Order[] = [];
  private readonly pendingVip: Order[] = [];
  private readonly pendingNormal: Order[] = [];
  private readonly bots: Bot[] = [];

  private readonly stats: OrderStats = {
    createdVip: 0,
    createdNormal: 0,
    completedVip: 0,
    completedNormal: 0,
  };

  constructor(
    { logger = new Logger(), processingTimeSeconds = 10 }: { logger?: Logger; processingTimeSeconds?: number } = {}
  ) {
    this.logger = logger;
    this.processingTimeSeconds = processingTimeSeconds;
  }

  readonly logger: Logger;
  readonly processingTimeSeconds: number;

  getBots(): ReadonlyArray<Bot> {
    return [...this.bots];
  }

  getOrders(): ReadonlyArray<Order> {
    return [...this.orders];
  }

  getPendingVip(): ReadonlyArray<Order> {
    return [...this.pendingVip];
  }

  getPendingNormal(): ReadonlyArray<Order> {
    return [...this.pendingNormal];
  }

  advanceTo(targetTime: number): void {
    if (targetTime < this.currentTime) {
      throw new Error(
        `Cannot move backwards in time (current: ${this.currentTime}, target: ${targetTime})`
      );
    }

    while (true) {
      const nextBot = this.findNextCompletingBot();
      if (
        !nextBot ||
        nextBot.busyUntil === null ||
        nextBot.busyUntil > targetTime
      ) {
        break;
      }

      const completionTime = nextBot.busyUntil;
      this.currentTime = completionTime;
      this.completeOrder(nextBot, completionTime);
      this.assignOrders(completionTime, { announceIdleForBots: [nextBot] });
    }

    this.currentTime = targetTime;
  }

  createOrder(type: OrderType, time = this.currentTime): Order {
    this.advanceTo(time);
    this.validateOrderType(type);

    const order: Order = {
      id: this.nextOrderId++,
      type,
      status: ORDER_STATUS.PENDING,
      createdAt: this.currentTime,
      startedAt: null,
      completedAt: null,
    };

    this.orders.push(order);
    if (type === ORDER_TYPES.VIP) {
      this.stats.createdVip += 1;
    } else {
      this.stats.createdNormal += 1;
    }

    this.enqueueOrder(order);

    this.logger.log(
      this.currentTime,
      `Created ${type} Order #${order.id} - Status: ${order.status}`
    );

    this.assignOrders(this.currentTime);

    return order;
  }

  addBot(time = this.currentTime): Bot {
    this.advanceTo(time);

    const bot: Bot = {
      id: this.nextBotId++,
      status: BOT_STATUS.IDLE,
      currentOrder: null,
      busyUntil: null,
      createdAt: this.currentTime,
      lastIdleAnnouncement: null,
    };

    this.bots.push(bot);
    this.logger.log(this.currentTime, `Bot #${bot.id} created - Status: ACTIVE`);

    this.assignOrders(this.currentTime);

    return bot;
  }

  removeBot(time = this.currentTime): Bot | null {
    this.advanceTo(time);

    if (this.bots.length === 0) {
      this.logger.log(this.currentTime, "No bots available to destroy");
      return null;
    }

    const bot = this.bots.pop() as Bot;

    if (bot.status === BOT_STATUS.PROCESSING && bot.currentOrder) {
      const order = bot.currentOrder;
      order.status = ORDER_STATUS.PENDING;
      order.startedAt = null;
      order.completedAt = null;

      this.enqueueOrder(order, { front: true });

      this.logger.log(
        this.currentTime,
        `Bot #${bot.id} destroyed while PROCESSING ${this.describeOrderType(
          order.type
        )} Order #${order.id} - Returned to PENDING`
      );
    } else {
      this.logger.log(this.currentTime, `Bot #${bot.id} destroyed while IDLE`);
    }

    this.assignOrders(this.currentTime);

    return bot;
  }

  finalize(time = this.currentTime): void {
    this.advanceTo(time);

    while (this.hasProcessingBots()) {
      const nextBot = this.findNextCompletingBot();
      if (!nextBot || nextBot.busyUntil === null) {
        break;
      }

      this.advanceTo(nextBot.busyUntil);
    }

    this.logger.pushRaw("");
    this.logger.pushRaw("Final Status:");

    const totalProcessed = this.stats.completedVip + this.stats.completedNormal;
    const pendingCount = this.pendingVip.length + this.pendingNormal.length;

    this.logger.pushRaw(
      `- Total Orders Processed: ${totalProcessed} (${this.stats.completedVip} VIP, ${this.stats.completedNormal} Normal)`
    );
    this.logger.pushRaw(`- Orders Completed: ${totalProcessed}`);
    this.logger.pushRaw(`- Active Bots: ${this.bots.length}`);
    this.logger.pushRaw(`- Pending Orders: ${pendingCount}`);
  }

  private hasProcessingBots(): boolean {
    return this.bots.some((bot) => bot.status === BOT_STATUS.PROCESSING);
  }

  private assignOrders(time: number, options: AssignOptions = {}): void {
    const idleBots = this.bots
      .filter((bot) => bot.status === BOT_STATUS.IDLE)
      .sort((a, b) => a.id - b.id);

    for (const bot of idleBots) {
      const order = this.dequeueOrder();
      if (!order) {
        continue;
      }

      this.startProcessing(bot, order, time);
    }

    const noPendingOrders =
      this.pendingVip.length === 0 && this.pendingNormal.length === 0;
    const anyProcessing = this.hasProcessingBots();
    const announceIdleForBots = options.announceIdleForBots ?? [];

    if (noPendingOrders && announceIdleForBots.length > 0) {
      const botsToAnnounce = new Set<Bot>(announceIdleForBots);

      if (!anyProcessing) {
        for (const bot of this.bots) {
          if (bot.status === BOT_STATUS.IDLE) {
            botsToAnnounce.add(bot);
          }
        }
      }

      for (const bot of botsToAnnounce) {
        if (
          bot.status === BOT_STATUS.IDLE &&
          bot.lastIdleAnnouncement !== time
        ) {
          this.logger.log(
            time,
            `Bot #${bot.id} is now IDLE - No pending orders`
          );
          bot.lastIdleAnnouncement = time;
        }
      }
    }
  }

  private startProcessing(bot: Bot, order: Order, time: number): void {
    order.status = ORDER_STATUS.PROCESSING;
    order.startedAt = time;
    bot.status = BOT_STATUS.PROCESSING;
    bot.currentOrder = order;
    bot.busyUntil = time + this.processingTimeSeconds;
    bot.lastIdleAnnouncement = null;

    this.logger.log(
      time,
      `Bot #${bot.id} picked up ${this.describeOrderType(order.type)} Order #${
        order.id
      } - Status: ${order.status}`
    );
  }

  private completeOrder(bot: Bot, time: number): void {
    const order = bot.currentOrder;
    if (!order) {
      return;
    }

    order.status = ORDER_STATUS.COMPLETE;
    order.completedAt = time;

    if (order.type === ORDER_TYPES.VIP) {
      this.stats.completedVip += 1;
    } else {
      this.stats.completedNormal += 1;
    }

    const processingTime =
      order.startedAt !== null ? time - order.startedAt : 0;

    this.logger.log(
      time,
      `Bot #${bot.id} completed ${this.describeOrderType(order.type)} Order #${
        order.id
      } - Status: ${order.status} (Processing time: ${processingTime}s)`
    );

    bot.status = BOT_STATUS.IDLE;
    bot.currentOrder = null;
    bot.busyUntil = null;
  }

  private findNextCompletingBot(): Bot | null {
    let nextBot: Bot | null = null;

    for (const bot of this.bots) {
      if (bot.status !== BOT_STATUS.PROCESSING || bot.busyUntil === null) {
        continue;
      }

      if (
        !nextBot ||
        nextBot.busyUntil === null ||
        bot.busyUntil < nextBot.busyUntil ||
        (bot.busyUntil === nextBot.busyUntil && bot.id < nextBot.id)
      ) {
        nextBot = bot;
      }
    }

    return nextBot;
  }

  private dequeueOrder(): Order | null {
    if (this.pendingVip.length > 0) {
      return this.pendingVip.shift() ?? null;
    }

    if (this.pendingNormal.length > 0) {
      return this.pendingNormal.shift() ?? null;
    }

    return null;
  }

  private enqueueOrder(order: Order, options: { front?: boolean } = {}): void {
    const queue =
      order.type === ORDER_TYPES.VIP ? this.pendingVip : this.pendingNormal;

    if (options.front) {
      queue.unshift(order);
    } else {
      queue.push(order);
    }
  }

  private describeOrderType(type: OrderType): OrderType {
    return type === ORDER_TYPES.VIP ? ORDER_TYPES.VIP : ORDER_TYPES.NORMAL;
  }

  private validateOrderType(type: OrderType): void {
    if (type !== ORDER_TYPES.VIP && type !== ORDER_TYPES.NORMAL) {
      throw new Error(`Unsupported order type: ${type}`);
    }
  }
}
