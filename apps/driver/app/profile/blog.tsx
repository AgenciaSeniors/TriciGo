import React, { useState, useEffect } from 'react';
import { View, Pressable, RefreshControl, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { useTranslation } from '@tricigo/i18n';
import { colors, driverDarkColors } from '@tricigo/theme';
import { StaggeredList } from '@tricigo/ui/AnimatedCard';
import { getSupabaseClient } from '@tricigo/api';

type BlogPost = {
  id: string;
  title: string;
  summary: string;
  url: string;
  published_at: string;
  category: string;
};

export default function BlogScreen() {
  const { t } = useTranslation('common');
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchPosts = async () => {
    try {
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from('blog_posts')
        .select('*')
        .eq('audience', 'driver')
        .order('published_at', { ascending: false })
        .limit(20);
      setPosts((data as BlogPost[]) ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchPosts();
  }, []);

  return (
    <Screen
      scroll
      bg="dark"
      statusBarStyle="light-content"
      padded
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchPosts(); }} tintColor={colors.brand.orange} />}
    >
      <View className="pt-4 pb-8">
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: driverDarkColors.hover }}
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[50]} />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.blog', { defaultValue: 'Blog' })}</Text>
        </View>

        {loading && (
          <View className="gap-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {!loading && posts.length === 0 && (
          <EmptyState
            icon="newspaper-outline"
            title={t('profile.no_posts', { defaultValue: 'Sin artículos aún' })}
            message={t('profile.no_posts_desc', { defaultValue: 'Próximamente encontrarás noticias y consejos aquí.' })}
          />
        )}

        {posts.length > 0 && (
          <StaggeredList staggerDelay={80}>
            {posts.map((post) => (
              <Pressable
                key={post.id}
                onPress={() => Linking.openURL(post.url)}
                className="rounded-2xl p-4 mb-3"
                style={{ backgroundColor: driverDarkColors.card, borderWidth: 1, borderColor: driverDarkColors.border.default }}
              >
                <View className="flex-row items-center mb-2">
                  <View className="px-2 py-0.5 rounded-full mr-2" style={{ backgroundColor: `${colors.brand.orange}20` }}>
                    <Text variant="caption" color="accent">{post.category}</Text>
                  </View>
                  <Text variant="caption" style={{ color: colors.neutral[500] }}>
                    {new Date(post.published_at).toLocaleDateString()}
                  </Text>
                </View>
                <Text variant="body" color="inverse" className="font-semibold mb-1">{post.title}</Text>
                <Text variant="bodySmall" color="secondary" numberOfLines={2}>{post.summary}</Text>
              </Pressable>
            ))}
          </StaggeredList>
        )}
      </View>
    </Screen>
  );
}
