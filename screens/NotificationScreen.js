import React, { useState, useEffect, useContext } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
  StatusBar,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import PushNotification from 'react-native-push-notification';
import { UserContext } from './UserContext';
import { gymTheme, gymStyles } from '../styles/theme';
import CommonHeader from './CommonHeader';
import LinearGradient from 'react-native-linear-gradient';
import * as Animatable from 'react-native-animatable';

export default function NotificationScreen({ navigation }) {
  const { user } = useContext(UserContext);
  const [notifications, setNotifications] = useState({
    workoutReminder: false,
    goalReminder: false,
    restDayReminder: false,
    achievementNotification: true,
    weeklyReport: true,
  });
  const [reminderTimes, setReminderTimes] = useState({
    workout: new Date(),
    goal: new Date(),
    restDay: new Date(),
  });
  const [showTimePicker, setShowTimePicker] = useState(null);

  useEffect(() => {
    loadNotificationSettings();
    configurePushNotifications();
  }, []);

  const configurePushNotifications = () => {
    PushNotification.configure({
      onRegister: function (token) {
        console.log('TOKEN:', token);
      },
      onNotification: function (notification) {
        console.log('NOTIFICATION:', notification);
      },
      permissions: {
        alert: true,
        badge: true,
        sound: true,
      },
      popInitialNotification: true,
      requestPermissions: Platform.OS === 'ios',
    });
  };

  const loadNotificationSettings = async () => {
    try {
      const savedSettings = await AsyncStorage.getItem(`notifications_${user?.id}`);
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        setNotifications(settings.notifications || notifications);
        setReminderTimes(settings.reminderTimes || reminderTimes);
      }
    } catch (error) {
      console.error('알림 설정 불러오기 실패:', error);
    }
  };

  const saveNotificationSettings = async () => {
    try {
      const settings = {
        notifications,
        reminderTimes,
      };
      await AsyncStorage.setItem(`notifications_${user?.id}`, JSON.stringify(settings));
      Alert.alert('성공', '알림 설정이 저장되었습니다!');
    } catch (error) {
      Alert.alert('오류', '알림 설정 저장에 실패했습니다.');
    }
  };

  const toggleNotification = (type) => {
    setNotifications(prev => ({
      ...prev,
      [type]: !prev[type]
    }));
  };

  const updateReminderTime = (type, time) => {
    setReminderTimes(prev => ({
      ...prev,
      [type]: time
    }));
    setShowTimePicker(null);
  };

  const scheduleWorkoutReminder = () => {
    if (!notifications.workoutReminder) return;

    const now = new Date();
    const reminderTime = new Date(reminderTimes.workout);
    reminderTime.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());

    if (reminderTime <= now) {
      reminderTime.setDate(reminderTime.getDate() + 1);
    }

    PushNotification.localNotificationSchedule({
      title: '🏋️ 운동 시간입니다!',
      message: '오늘의 운동을 시작해보세요. 건강한 하루를 만들어보세요!',
      date: reminderTime,
      repeatType: 'day',
      actions: ['운동 시작', '나중에'],
    });
  };

  const scheduleGoalReminder = () => {
    if (!notifications.goalReminder) return;

    const now = new Date();
    const reminderTime = new Date(reminderTimes.goal);
    reminderTime.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());

    if (reminderTime <= now) {
      reminderTime.setDate(reminderTime.getDate() + 1);
    }

    PushNotification.localNotificationSchedule({
      title: '🎯 목표 달성 체크!',
      message: '오늘의 운동 목표를 확인하고 달성해보세요!',
      date: reminderTime,
      repeatType: 'day',
      actions: ['목표 확인', '나중에'],
    });
  };

  const scheduleRestDayReminder = () => {
    if (!notifications.restDayReminder) return;

    const now = new Date();
    const reminderTime = new Date(reminderTimes.restDay);
    reminderTime.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());

    if (reminderTime <= now) {
      reminderTime.setDate(reminderTime.getDate() + 1);
    }

    PushNotification.localNotificationSchedule({
      title: '😴 휴식일 알림',
      message: '오늘은 휴식일입니다. 충분한 휴식을 취하세요!',
      date: reminderTime,
      repeatType: 'day',
      actions: ['확인', '나중에'],
    });
  };

  const testNotification = () => {
    PushNotification.localNotification({
      title: '🔔 테스트 알림',
      message: '알림이 정상적으로 작동합니다!',
      actions: ['확인'],
    });
  };

  const NotificationItem = ({ 
    title, 
    description, 
    type, 
    timeType, 
    icon, 
    enabled, 
    onToggle, 
    onTimePress 
  }) => (
    <Animatable.View
      animation="fadeInUp"
      duration={300}
      style={styles.notificationItem}
    >
      <View style={styles.notificationHeader}>
        <View style={styles.notificationIcon}>
          <Text style={styles.iconText}>{icon}</Text>
        </View>
        <View style={styles.notificationInfo}>
          <Text style={styles.notificationTitle}>{title}</Text>
          <Text style={styles.notificationDescription}>{description}</Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          trackColor={{ false: gymTheme.colors.border, true: gymTheme.colors.accent }}
          thumbColor={enabled ? gymTheme.colors.text : gymTheme.colors.textMuted}
        />
      </View>
      
      {enabled && timeType && (
        <TouchableOpacity
          style={styles.timeButton}
          onPress={() => setShowTimePicker(timeType)}
        >
          <Ionicons name="time-outline" size={20} color={gymTheme.colors.accent} />
          <Text style={styles.timeText}>
            {reminderTimes[timeType].toLocaleTimeString('ko-KR', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </TouchableOpacity>
      )}
    </Animatable.View>
  );

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={gymTheme.colors.primary} />
      
      <CommonHeader 
        navigation={navigation}
        title="알림 설정"
        rightComponent={
          <TouchableOpacity
            onPress={saveNotificationSettings}
            style={styles.headerButton}
          >
            <Ionicons name="save-outline" size={24} color={gymTheme.colors.text} />
          </TouchableOpacity>
        }
      />

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        {/* 알림 설정 안내 */}
        <LinearGradient
          colors={gymTheme.gradients.card}
          style={styles.infoCard}
        >
          <Ionicons name="notifications" size={32} color={gymTheme.colors.accent} />
          <Text style={styles.infoTitle}>알림으로 운동을 잊지 마세요!</Text>
          <Text style={styles.infoText}>
            운동 리마인더와 목표 달성 알림을 받아보세요.
          </Text>
        </LinearGradient>

        {/* 운동 리마인더 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🏋️ 운동 리마인더</Text>
          
          <NotificationItem
            title="운동 시간 알림"
            description="매일 정해진 시간에 운동 알림을 받습니다"
            type="workoutReminder"
            timeType="workout"
            icon="⏰"
            enabled={notifications.workoutReminder}
            onToggle={() => toggleNotification('workoutReminder')}
            onTimePress={() => setShowTimePicker('workout')}
          />
          
          <NotificationItem
            title="목표 달성 체크"
            description="목표 달성 여부를 확인하도록 알려드립니다"
            type="goalReminder"
            timeType="goal"
            icon="🎯"
            enabled={notifications.goalReminder}
            onToggle={() => toggleNotification('goalReminder')}
            onTimePress={() => setShowTimePicker('goal')}
          />
          
          <NotificationItem
            title="휴식일 알림"
            description="휴식일을 알려드립니다"
            type="restDayReminder"
            timeType="restDay"
            icon="😴"
            enabled={notifications.restDayReminder}
            onToggle={() => toggleNotification('restDayReminder')}
            onTimePress={() => setShowTimePicker('restDay')}
          />
        </View>

        {/* 성취 및 보고서 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🏆 성취 및 보고서</Text>
          
          <NotificationItem
            title="목표 달성 축하"
            description="목표를 달성했을 때 축하 메시지를 받습니다"
            type="achievementNotification"
            icon="🎉"
            enabled={notifications.achievementNotification}
            onToggle={() => toggleNotification('achievementNotification')}
          />
          
          <NotificationItem
            title="주간 리포트"
            description="매주 운동 성과를 요약해서 알려드립니다"
            type="weeklyReport"
            icon="📊"
            enabled={notifications.weeklyReport}
            onToggle={() => toggleNotification('weeklyReport')}
          />
        </View>

        {/* 테스트 및 저장 */}
        <View style={styles.actionSection}>
          <TouchableOpacity style={styles.testButton} onPress={testNotification}>
            <LinearGradient
              colors={gymTheme.gradients.accent}
              style={styles.testButtonGradient}
            >
              <Ionicons name="notifications-outline" size={20} color={gymTheme.colors.text} />
              <Text style={styles.testButtonText}>알림 테스트</Text>
            </LinearGradient>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.saveButton} onPress={saveNotificationSettings}>
            <LinearGradient
              colors={gymTheme.gradients.primary}
              style={styles.saveButtonGradient}
            >
              <Ionicons name="save-outline" size={20} color={gymTheme.colors.text} />
              <Text style={styles.saveButtonText}>설정 저장</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* 알림 권한 안내 */}
        <View style={styles.permissionInfo}>
          <Ionicons name="information-circle-outline" size={20} color={gymTheme.colors.textSecondary} />
          <Text style={styles.permissionText}>
            알림을 받으려면 기기 설정에서 알림 권한을 허용해주세요.
          </Text>
        </View>
      </ScrollView>

      {/* 시간 선택기 */}
      {showTimePicker && (
        <DateTimePicker
          value={reminderTimes[showTimePicker]}
          mode="time"
          is24Hour={true}
          display="default"
          onChange={(event, selectedTime) => {
            if (selectedTime) {
              updateReminderTime(showTimePicker, selectedTime);
            } else {
              setShowTimePicker(null);
            }
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: gymTheme.colors.primary,
  },
  
  scrollView: {
    flex: 1,
  },
  
  content: {
    padding: gymTheme.spacing.lg,
  },
  
  headerButton: {
    padding: gymTheme.spacing.sm,
  },
  
  infoCard: {
    backgroundColor: gymTheme.colors.card,
    borderRadius: gymTheme.borderRadius.large,
    padding: gymTheme.spacing.lg,
    marginBottom: gymTheme.spacing.xl,
    alignItems: 'center',
    ...gymTheme.shadows.medium,
  },
  
  infoTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: gymTheme.colors.text,
    marginTop: gymTheme.spacing.md,
    marginBottom: gymTheme.spacing.sm,
  },
  
  infoText: {
    fontSize: 14,
    color: gymTheme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  
  section: {
    marginBottom: gymTheme.spacing.xl,
  },
  
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: gymTheme.colors.text,
    marginBottom: gymTheme.spacing.lg,
  },
  
  notificationItem: {
    backgroundColor: gymTheme.colors.card,
    borderRadius: gymTheme.borderRadius.medium,
    padding: gymTheme.spacing.lg,
    marginBottom: gymTheme.spacing.md,
    ...gymTheme.shadows.small,
  },
  
  notificationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  
  notificationIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: gymTheme.colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: gymTheme.spacing.md,
  },
  
  iconText: {
    fontSize: 20,
  },
  
  notificationInfo: {
    flex: 1,
  },
  
  notificationTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: gymTheme.colors.text,
    marginBottom: 4,
  },
  
  notificationDescription: {
    fontSize: 14,
    color: gymTheme.colors.textSecondary,
    lineHeight: 18,
  },
  
  timeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: gymTheme.spacing.md,
    paddingVertical: gymTheme.spacing.sm,
    paddingHorizontal: gymTheme.spacing.md,
    backgroundColor: gymTheme.colors.secondary,
    borderRadius: gymTheme.borderRadius.small,
  },
  
  timeText: {
    fontSize: 14,
    color: gymTheme.colors.text,
    marginLeft: gymTheme.spacing.sm,
  },
  
  actionSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: gymTheme.spacing.xl,
  },
  
  testButton: {
    flex: 1,
    marginRight: gymTheme.spacing.sm,
    borderRadius: gymTheme.borderRadius.medium,
    overflow: 'hidden',
  },
  
  testButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: gymTheme.spacing.md,
  },
  
  testButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: gymTheme.colors.text,
    marginLeft: gymTheme.spacing.sm,
  },
  
  saveButton: {
    flex: 1,
    marginLeft: gymTheme.spacing.sm,
    borderRadius: gymTheme.borderRadius.medium,
    overflow: 'hidden',
  },
  
  saveButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: gymTheme.spacing.md,
  },
  
  saveButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: gymTheme.colors.text,
    marginLeft: gymTheme.spacing.sm,
  },
  
  permissionInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: gymTheme.colors.secondary,
    borderRadius: gymTheme.borderRadius.medium,
    padding: gymTheme.spacing.md,
  },
  
  permissionText: {
    fontSize: 12,
    color: gymTheme.colors.textSecondary,
    marginLeft: gymTheme.spacing.sm,
    flex: 1,
    lineHeight: 16,
  },
});












