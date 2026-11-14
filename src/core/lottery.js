'use strict';

/**
 * 娱乐抽签：骰子 / 抽签 / 塔罗（零依赖）。
 * 纯函数，rng 可注入便于测试；签文、牌意都内嵌在这里，不落 assets、不做配置。
 */

const LOTS = [
  { level: '上上', text: '云开见月明，所求皆有望。', note: '别急着下结论，转机就在这一两天。' },
  { level: '上吉', text: '顺水行舟，事半功倍。', note: '贵人正在路上，主动开口就有。' },
  { level: '上吉', text: '花自开时月自圆。', note: '你惦记的事会自己变好，先别折腾。' },
  { level: '中吉', text: '柳暗花明又一村。', note: '眼前卡一下是暂时的，绕个弯就通。' },
  { level: '中吉', text: '稳坐钓鱼台。', note: '按兵不动就是最好的动作。' },
  { level: '中吉', text: '细雨润物，静待其成。', note: '慢一点没关系，方向没错。' },
  { level: '中平', text: '雾里看花，看不真切。', note: '先把没弄明白的问清楚，再决定。' },
  { level: '中平', text: '有得必有失，秤要端平。', note: '别两头都要，选一个最想要的。' },
  { level: '中平', text: '船到桥头自然直。', note: '现在想太多没用，走一步看一步。' },
  { level: '中平', text: '镜花水月，莫太当真。', note: '别把一时的话当成承诺。' },
  { level: '中下', text: '逆风而行，且慢且稳。', note: '最近别硬刚，缓一缓再动。' },
  { level: '中下', text: '灯下黑，最该看的没看见。', note: '再查一遍，漏掉的东西就在手边。' },
  { level: '下', text: '山重水复，未到穷时。', note: '难是真的难，但还没到底，先别认。' },
  { level: '下', text: '空谷回音，说了也没人应。', note: '别在没人听的地方耗着，换个说的人。' },
  { level: '下', text: '覆水难收，不如向前。', note: '已经泼出去的水，别回头捡了。' },
  { level: '上上', text: '吉星高照，万事顺遂。', note: '今天运气不错，想做的就去做。' },
];

const TAROT = [
  { name: '愚者', upright: '新的开始，勇敢迈出第一步', reversed: '冲动或没想清楚就上路' },
  { name: '魔术师', upright: '你有能力把想法变成现实', reversed: '空有想法，缺少行动' },
  { name: '女祭司', upright: '相信直觉，静观其变', reversed: '忽略了内心的声音' },
  { name: '女皇', upright: '丰盛、滋养，事情在生长', reversed: '过度付出，先照顾好自己' },
  { name: '皇帝', upright: '秩序与掌控，稳住局面', reversed: '太想控制反而失控' },
  { name: '教皇', upright: '循规蹈矩，听有经验的人', reversed: '规则可以变通，别盲从' },
  { name: '恋人', upright: '选择与契合，心意相通', reversed: '摇摆不定，或价值观不合' },
  { name: '战车', upright: '目标明确，一往无前', reversed: '方向感丢了，或用力过猛' },
  { name: '力量', upright: '温柔地驾驭，不用硬碰硬', reversed: '心有余而力不足' },
  { name: '隐者', upright: '独处思考，答案在自己', reversed: '把自己关得太久，该出来了' },
  { name: '命运之轮', upright: '时来运转，顺势而为', reversed: '时机未到，再等一等' },
  { name: '正义', upright: '公平的结果，因果分明', reversed: '偏颇，或结果没兑现' },
  { name: '倒吊人', upright: '换个角度看，慢下来是选择', reversed: '卡在原地，却不放手' },
  { name: '死神', upright: '旧的结束，新的开始', reversed: '害怕改变，拖着不肯走' },
  { name: '节制', upright: '平衡与调和，刚刚好', reversed: '过犹不及，某件事失衡了' },
  { name: '恶魔', upright: '被欲望或执念绑住', reversed: '正在挣脱，看清了牵绊' },
  { name: '高塔', upright: '突然的崩塌，逼你重建', reversed: '躲过一劫，但隐患还在' },
  { name: '星星', upright: '希望与疗愈，慢慢变好', reversed: '信心不足，别急着否定自己' },
  { name: '月亮', upright: '模糊与不安，真相没看清', reversed: '迷雾开始散去，别自己吓自己' },
  { name: '太阳', upright: '圆满与快乐，一切明朗', reversed: '短暂的阴霾，别放大它' },
  { name: '审判', upright: '复盘与觉醒，该翻篇了', reversed: '逃避自己的判断' },
  { name: '世界', upright: '一个阶段的圆满收尾', reversed: '差最后一步，别半途而废' },
];

function rollDice(rng = Math.random) {
  return Math.floor(rng() * 6) + 1;
}

function drawLots(rng = Math.random) {
  return LOTS[Math.floor(rng() * LOTS.length)];
}

function drawTarot(rng = Math.random) {
  const card = TAROT[Math.floor(rng() * TAROT.length)];
  const isReversed = rng() < 0.5;
  return { name: card.name, upright: card.upright, reversed: card.reversed, isReversed };
}

module.exports = { LOTS, TAROT, rollDice, drawLots, drawTarot };
