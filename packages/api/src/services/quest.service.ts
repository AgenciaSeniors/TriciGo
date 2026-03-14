import { getSupabaseClient } from '../client';
import type { Quest, QuestProgress, QuestWithProgress } from '@tricigo/types';

export const questService = {
  async getActiveQuests(): Promise<Quest[]> {
    const supabase = getSupabaseClient();
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('driver_quests')
      .select('*')
      .eq('is_active', true)
      .lte('start_date', today)
      .gte('end_date', today)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Quest[];
  },

  async getAllQuests(page = 0, pageSize = 20): Promise<Quest[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('driver_quests')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as Quest[];
  },

  async getDriverQuestProgress(driverId: string): Promise<QuestWithProgress[]> {
    const supabase = getSupabaseClient();
    const today = new Date().toISOString().split('T')[0];

    const { data: quests, error: qErr } = await supabase
      .from('driver_quests')
      .select('*')
      .eq('is_active', true)
      .lte('start_date', today)
      .gte('end_date', today);
    if (qErr) throw qErr;

    const { data: progress, error: pErr } = await supabase
      .from('driver_quest_progress')
      .select('*')
      .eq('driver_id', driverId);
    if (pErr) throw pErr;

    const progressMap = new Map(
      ((progress ?? []) as QuestProgress[]).map((p) => [p.quest_id, p]),
    );

    return ((quests ?? []) as Quest[]).map((q) => ({
      ...q,
      progress: progressMap.get(q.id),
    }));
  },

  async updateQuestProgress(
    driverId: string,
    questType: string,
    incrementBy: number,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const today = new Date().toISOString().split('T')[0];

    // Get active quests of this type
    const { data: quests } = await supabase
      .from('driver_quests')
      .select('id, target_value, reward_cup')
      .eq('quest_type', questType)
      .eq('is_active', true)
      .lte('start_date', today)
      .gte('end_date', today);

    if (!quests || quests.length === 0) return;

    for (const quest of quests) {
      // Upsert progress
      const { data: existing } = await supabase
        .from('driver_quest_progress')
        .select('id, current_value, completed_at')
        .eq('quest_id', quest.id)
        .eq('driver_id', driverId)
        .maybeSingle();

      if (existing?.completed_at) continue; // Already completed

      const newValue = (existing?.current_value ?? 0) + incrementBy;
      const completed = newValue >= quest.target_value;

      if (existing) {
        await supabase
          .from('driver_quest_progress')
          .update({
            current_value: newValue,
            ...(completed ? { completed_at: new Date().toISOString() } : {}),
          })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('driver_quest_progress')
          .insert({
            quest_id: quest.id,
            driver_id: driverId,
            current_value: newValue,
            ...(completed ? { completed_at: new Date().toISOString() } : {}),
          });
      }
    }
  },

  async createQuest(
    data: Omit<Quest, 'id' | 'created_at'>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('driver_quests').insert(data);
    if (error) throw error;
  },

  async toggleQuest(questId: string, isActive: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_quests')
      .update({ is_active: isActive })
      .eq('id', questId);
    if (error) throw error;
  },
};
