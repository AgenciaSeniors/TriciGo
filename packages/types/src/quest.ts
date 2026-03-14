export type QuestType = 'trip_count' | 'earnings' | 'rating' | 'hours_online' | 'peak_hours';

export interface Quest {
  id: string;
  title_es: string;
  title_en: string;
  description_es: string;
  description_en: string;
  quest_type: QuestType;
  target_value: number;
  reward_cup: number;
  start_date: string;
  end_date: string;
  is_active: boolean;
  created_at: string;
}

export interface QuestProgress {
  id: string;
  quest_id: string;
  driver_id: string;
  current_value: number;
  completed_at: string | null;
  reward_paid: boolean;
  created_at: string;
}

export interface QuestWithProgress extends Quest {
  progress?: QuestProgress;
}
