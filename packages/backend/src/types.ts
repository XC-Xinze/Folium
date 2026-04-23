export type CardStatus = 'ATOMIC' | 'INDEX';

export interface Card {
  luhmannId: string;
  title: string;
  status: CardStatus;
  parentId: string | null;
  sortKey: string;
  depth: number;
  contentMd: string;
  tags: string[];
  crossLinks: string[];
  filePath: string;
  mtime: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CardSummary {
  luhmannId: string;
  title: string;
  status: CardStatus;
  tags: string[];
  depth: number;
  sortKey: string;
  crossLinks: string[];
}

export interface ReferencedFromHit {
  sourceId: string;
  sourceTitle: string;
  paragraph: string;
}

export interface PotentialLink {
  luhmannId: string;
  title: string;
  score: number;
  reasons: string[];
}
