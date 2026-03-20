import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, Pressable, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { blogService } from '@tricigo/api';
import type { BlogPost } from '@tricigo/api';
import i18next from 'i18next';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
import { ScrollView } from 'react-native';

const PAGE_SIZE = 10;

export default function BlogScreen() {
  const { t } = useTranslation('common');
  const lang = i18next.language === 'en' ? 'en' : 'es';

  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [selectedPost, setSelectedPost] = useState<BlogPost | null>(null);

  const fetchPosts = useCallback(async (pageNum: number, reset = false) => {
    try {
      const data = await blogService.getPublishedPosts(pageNum, PAGE_SIZE);
      if (reset) {
        setPosts(data);
      } else {
        setPosts((prev) => [...prev, ...data]);
      }
      setHasMore(data.length === PAGE_SIZE);
      setPage(pageNum);
    } catch (err) {
      console.warn('[Blog] Failed to load:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchPosts(0, true);
  }, [fetchPosts]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchPosts(0, true);
  }, [fetchPosts]);

  const onEndReached = useCallback(() => {
    if (!hasMore || loading) return;
    fetchPosts(page + 1);
  }, [hasMore, loading, page, fetchPosts]);

  const getTitle = (post: BlogPost) => lang === 'en' ? post.title_en : post.title_es;
  const getExcerpt = (post: BlogPost) => lang === 'en' ? post.excerpt_en : post.excerpt_es;
  const getBody = (post: BlogPost) => lang === 'en' ? post.body_en : post.body_es;

  const renderPost = ({ item }: { item: BlogPost }) => (
    <Pressable onPress={() => setSelectedPost(item)}>
      <Card variant="outlined" padding="md" className="mb-3">
        <Text variant="body" className="font-semibold mb-1">
          {getTitle(item)}
        </Text>
        <Text variant="bodySmall" color="secondary" numberOfLines={3}>
          {getExcerpt(item)}
        </Text>
        {item.published_at && (
          <Text variant="caption" color="tertiary" className="mt-2">
            {new Date(item.published_at).toLocaleDateString('es-CU', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </Text>
        )}
      </Card>
    </Pressable>
  );

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <ScreenHeader
          title={t('profile.blog_title', { defaultValue: 'Blog TriciGo' })}
          onBack={() => router.back()}
        />

        <FlatList
          data={posts}
          keyExtractor={(item) => item.id}
          renderItem={renderPost}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand.orange} />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListEmptyComponent={
            !loading ? (
              <View className="items-center py-12">
                <Ionicons name="newspaper-outline" size={48} color={colors.neutral[300]} />
                <Text variant="body" color="secondary" className="mt-3">
                  {t('profile.no_blog_posts', { defaultValue: 'No hay publicaciones aún' })}
                </Text>
              </View>
            ) : null
          }
        />
      </View>

      {/* Post detail bottom sheet */}
      <BottomSheet
        visible={!!selectedPost}
        onClose={() => setSelectedPost(null)}
      >
        {selectedPost && (
          <ScrollView className="px-4 pb-6" style={{ maxHeight: 500 }}>
            <Text variant="h3" className="mb-2">
              {getTitle(selectedPost)}
            </Text>
            {selectedPost.published_at && (
              <Text variant="caption" color="tertiary" className="mb-4">
                {new Date(selectedPost.published_at).toLocaleDateString('es-CU', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>
            )}
            <Text variant="body" color="primary" className="leading-6">
              {getBody(selectedPost)}
            </Text>
          </ScrollView>
        )}
      </BottomSheet>
    </Screen>
  );
}
