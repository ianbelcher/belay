// Names for new sessions, two words like sly-fox or amazing-whale: easy to tell apart, to say, and to rename.

const ADJECTIVES = [
  'amazing', 'ample', 'artful', 'bold', 'brave', 'bright', 'brisk', 'calm', 'candid', 'clever', 'cosmic', 'crisp',
  'curious', 'daring', 'dapper', 'deft', 'eager', 'early', 'easy', 'electric', 'epic', 'fair', 'fancy', 'fearless',
  'fierce', 'fleet', 'fond', 'fresh', 'friendly', 'gentle', 'giddy', 'glad', 'golden', 'grand', 'happy', 'hardy',
  'hearty', 'honest', 'humble', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'lunar', 'mellow', 'merry', 'mighty',
  'modest', 'nimble', 'noble', 'patient', 'plucky', 'polite', 'proud', 'quick', 'quiet', 'rapid', 'regal', 'rosy',
  'rustic', 'shiny', 'silent', 'sleek', 'sly', 'smart', 'snappy', 'solar', 'spry', 'steady', 'sunny', 'swift',
  'tidy', 'tough', 'trusty', 'upbeat', 'vivid', 'warm', 'wise', 'witty', 'zany', 'zesty',
];
const ANIMALS = [
  'badger', 'bat', 'bear', 'beaver', 'bison', 'bobcat', 'crane', 'crow', 'deer', 'dingo', 'dolphin', 'dove', 'eagle',
  'egret', 'elk', 'falcon', 'ferret', 'finch', 'fox', 'gecko', 'gibbon', 'goose', 'gull', 'hare', 'hawk', 'heron',
  'ibis', 'jackal', 'jaguar', 'koala', 'lark', 'lemur', 'lion', 'llama', 'lynx', 'magpie', 'marten', 'mink', 'moose',
  'newt', 'ocelot', 'orca', 'osprey', 'otter', 'owl', 'panda', 'panther', 'parrot', 'pelican', 'penguin', 'puffin',
  'quail', 'rabbit', 'raven', 'robin', 'salmon', 'seal', 'shark', 'sparrow', 'stork', 'swan', 'tapir', 'tiger',
  'toad', 'trout', 'turtle', 'viper', 'walrus', 'weasel', 'whale', 'wolf', 'wombat', 'wren', 'yak', 'zebra',
];

const pick = (list, rnd) => list[Math.floor(rnd() * list.length)];

/** A name no session in `taken` has: adjective-animal, with a number only if it comes to that. */
export function sessionName(taken = new Set(), rnd = Math.random) {
  for (let i = 0; i < 50; i++) {
    const n = `${pick(ADJECTIVES, rnd)}-${pick(ANIMALS, rnd)}`;
    if (!taken.has(n)) return n;
  }
  let i = 2;
  const base = `${pick(ADJECTIVES, rnd)}-${pick(ANIMALS, rnd)}`;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
