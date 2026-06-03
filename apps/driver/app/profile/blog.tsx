import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, RefreshControl, ScrollView, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import i18next from 'i18next';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark, colors } from '@tricigo/theme';
import { StaggeredList } from '@tricigo/ui/AnimatedCard';
import { blogService } from '@tricigo/api';
import type { BlogPost } from '@tricigo/api';
import { logger, formatTimestamp } from '@tricigo/utils';

export default function BlogScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  // Posts are bilingual (title_es/en, excerpt_es/en, body_es/en); pick the
  // active app language, defaulting to Spanish for any non-en locale.
  const lang = i18next.language === 'en' ? 'en' : 'es';

  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPost, setSelectedPost] = useState<BlogPost | null>(null);

  // Use the shared blogService (same as the rider + web apps), which filters
  // on the real `is_published` column. The previous direct query filtered on
  // a non-existent `audience` column, so it always returned 0 rows.
  const fetchPosts = useCallback(async () => {
    try {
      const data = await blogService.getPublishedPosts(0, 20);
      setPosts(data);
    } catch (err) {
      logger.warn('[Blog] Failed to load:', { error: String(err) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchPosts();
  }, [fetchPosts]);

  const getTitle = (post: BlogPost) => (lang === 'en' ? post.title_en : post.title_es);
  const getExcerpt = (post: BlogPost) => (lang === 'en' ? post.excerpt_en : post.excerpt_es);
  const getBody = (post: BlogPost) => (lang === 'en' ? post.body_en : post.body_es);

  return (
    <Screen
      scroll
      bg={isDark ? 'dark' : 'white'}
      statusBarStyle={isDark ? 'light-content' : 'dark-content'}
      padded
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchPosts(); }} tintColor={colors.brand.orange} />}
    >
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4 pb-8">
        <ProfileScreenHeader
          title={t('profile.blog', { defaultValue: 'Blog' })}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back', { defaultValue: 'Back' })}
        />

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
            description={t('profile.no_posts_desc', { defaultValue: 'Próximamente encontrarás noticias y consejos aquí.' })}
          />
        )}

        {posts.length > 0 && (
          <StaggeredList staggerDelay={80}>
            {posts.map((post) => (
              <Pressable
                key={post.id}
                onPress={() => setSelectedPost(post)}
                className="rounded-2xl p-4 mb-3"
                style={{ backgroundColor: midnightEmber.screen.bg.surface, borderWidth: 1, borderColor: midnightEmber.screen.line.default }}
              >
                {post.published_at && (
                  <Text variant="caption" style={{ color: midnightEmber.screen.text.tertiary }} className="mb-1">
                    {formatTimestamp(post.published_at, 'absolute')}
                  </Text>
                )}
                <Text variant="body" color="primary" className="font-semibold mb-1">{getTitle(post)}</Text>
                <Text variant="bodySmall" color="secondary" numberOfLines={2}>{getExcerpt(post)}</Text>
              </Pressable>
            ))}
          </StaggeredList>
        )}
      </View>
      </View>

      {/* Post detail — in-app reader (no external URL on blog_posts). */}
      <BottomSheet visible={!!selectedPost} onClose={() => setSelectedPost(null)}>
        {selectedPost && (
          <ScrollView style={{ maxHeight: 500 }}>
            <Text variant="h3" color="primary" className="mb-2">{getTitle(selectedPost)}</Text>
            {selectedPost.published_at && (
              <Text variant="caption" color="tertiary" className="mb-4">
                {formatTimestamp(selectedPost.published_at, 'absolute')}
              </Text>
            )}
            <Text variant="body" color="primary" className="leading-6">{getBody(selectedPost)}</Text>
          </ScrollView>
        )}
      </BottomSheet>
    </Screen>
  );
}
