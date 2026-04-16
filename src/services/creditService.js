import { redisClient } from './redis.js';

export const creditService = {
  async getBalance(userId) {
    const bal = await redisClient.get(`credits:${userId}`);
    return bal ? parseInt(bal, 10) : 0;
  },
  async addCredits(userId, amount) {
    await redisClient.incrby(`credits:${userId}`, amount);
  },
  async deductCredits(userId, amount) {
    const newBalance = await redisClient.decrby(`credits:${userId}`, amount);
    if (newBalance < 0) {
      await redisClient.incrby(`credits:${userId}`, amount);
      throw new Error('Insufficient credits');
    }
    return newBalance;
  },
  async logTransaction(userId, amount, type, metadata) {
    const log = JSON.stringify({ userId, amount, type, metadata, ts: Date.now() });
    await redisClient.lpush(`transactions:${userId}`, log);
    await redisClient.ltrim(`transactions:${userId}`, 0, 999);
  },
};