import React, { useState, useEffect, useContext, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, StatusBar,
  Alert, PermissionsAndroid, Platform, Linking, Modal, AppState, BackHandler
} from 'react-native';
import Video from 'react-native-video';
import { Picker } from '@react-native-picker/picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { UserContext } from './UserContext';
import { gymTheme } from '../styles/theme';
import CommonHeader from './CommonHeader';

// ================================
// API/유틸
// ================================
const API_BASE = 'http://13.209.67.129:8000';
const EXERCISE_DIR = { deadlift: 'deadlift', squat: 'squat', bench_press: 'bench_press' };

// ⚠️ 데이터 동기화 정책 (서버 우선 모드)
// 1. 서버 = 단일 진실 소스 (Single Source of Truth)
// 2. 로컬 스토리지 = 캐시 (빠른 로딩용)
// 3. 데이터 로딩 순서: 서버 먼저 → 서버 없으면 로컬 캐시
// 4. 영상 업로드 후: 서버 데이터로 완전 교체 (로컬 병합 없음)
// 5. 여러 기기 사용 시: 각 기기가 서버에서 최신 데이터 가져옴

// S3 경로 수정 (fitvideoresult 폴더 사용)
const S3_RESULT_FOLDER = 'fitvideoresult';

// 사용자 이름 포맷(업로드/다운로드 동일 폴더명 유지)
const sanitizeName = (u) => (u?.username || u?.name || '').replace(/\s+/g, '');

// YYYYMMDD (디바이스 로컬 기준; 필요 시 KST 로직 추가)
const toYYYYMMDD = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};

// yyyyMMddHHmmss
const buildTimestamp14 = (d = new Date()) => {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
};

// ✅ 선택한 운동 문자열 → ID(1/2/3)
const exerciseTypes = [
  { label: 'Deadlift', value: 'deadlift', id: 1, icon: '🏋️' },
  { label: 'Squat', value: 'squat', id: 2, icon: '🦵' },
  { label: 'Bench Press', value: 'bench_press', id: 3, icon: '💪' },
];
const getExerciseId = (exerciseValue) => {
  const ex = exerciseTypes.find(e => e.value === exerciseValue);
  return ex ? ex.id : 2; // 기본 squat
};

// ✅ 업로드용 S3 키(서버 파이프라인 형식, 5토큰 포함)
// 최종: fitvideo/{userId}_{userName}_{weightKg}_{exerciseId}_{timestamp}.mp4
const buildUploadKey = (user, weightKg, exerciseValue, ts14) => {
  const name = sanitizeName(user);
  const w = String(weightKg ?? '0');
  const exerciseId = getExerciseId(exerciseValue);
  return `fitvideo/${user.id}_${name}_${w}_${exerciseId}_${ts14}.mp4`;
};

// (선택) 업로드 presign(put) — 업로드 화면에서 사용할 때
const getPresignedPutUrl = async (key, contentType = 'video/mp4') => {
  const qs = new URLSearchParams({ key, content_type: contentType });
  const res = await fetch(`${API_BASE}/s3/presign?${qs.toString()}`);
  if (!res.ok) throw new Error('Presign(put) 실패');
  const { url } = await res.json();
  return url;
};

// ✅ 결과영상 presign(get) — 날짜+세트 기반
const getAnalyzedPresignedUrlByDateSet = async ({
  user,
  dateYmd,           // "YYYYMMDD"
  setNo,             // 1,2,3...
  exerciseValue,     // 'squat' | 'deadlift' | 'bench_press'
  download = true,
}) => {
  try {
    // 서버 API로 시도
    const params = new URLSearchParams({
      yyyymmdd: dateYmd,
      set_no: String(setNo),
      user_id: String(user.id),
      user_name: sanitizeName(user),
      exercise: EXERCISE_DIR[exerciseValue] || 'squat',
      download: download ? 'true' : 'false',
    });
    const apiUrl = `${API_BASE}/workouts/analyzed-url-by-date?${params.toString()}`;
    const res = await fetch(apiUrl);
    if (res.ok) {
      const responseData = await res.json();
      if (responseData.url) return responseData.url;
    }

    // 실패 시(백업 경로들 시도 — 운영 환경에선 서버 API만 쓰는 걸 권장)
    const s3Path = `${S3_RESULT_FOLDER}/${user.id}_${user.name}/${dateYmd}/${exerciseValue}/set${setNo}_${dateYmd}160000.mp4`;
    const directS3Url = `https://thefit-bucket.s3.ap-northeast-2.amazonaws.com/${s3Path}`;
    const headRes = await fetch(directS3Url, { method: 'HEAD' });
    if (headRes.ok) return directS3Url;

    throw new Error(`분석영상 URL을 가져올 수 없습니다. 서버 API: ${res.status}`);
  } catch (error) {
    console.error('❌ getAnalyzedPresignedUrlByDateSet 오류:', error);
    throw error;
  }
};

// ✅ 생성일 기준 날짜별 운동(총 reps 포함) 조회
const apiGetWorkoutsByDate = async ({ userId, dateYmd, exerciseValue }) => {
  const qs = new URLSearchParams({ exercise: exerciseValue });
  const url = `${API_BASE}/workouts/users/${userId}/date=${dateYmd}?${qs.toString()}`;
  console.log('📊 날짜별 운동 데이터 API:', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const payload = await res.json(); // { user_id, date, exercise_id, total_reps, items: [...] (각 item에 ai_feedback 포함) }
  return payload;
};

// === AI 피드백 파싱 유틸 ===
const aiMemoFromItem = (item) => {
  // item.ai_feedback: {headline, positives[], improvements[], action_items[]}
  const ai = item?.ai_feedback;
  if (!ai) return null;

  // 전체 AI 피드백 객체를 JSON 문자열로 저장
  try {
    return JSON.stringify(ai);
  } catch (error) {
    console.error('AI 피드백 JSON 변환 실패:', error);
    // 실패 시 headline만 반환
    return ai?.headline?.trim() || null;
  }
};

// fallbackMemoFromItem 제거 - ai_feedback만 사용

// S3 키에서 무게 추출 함수
// 형식: fitvideo/{userId}_{userName}_{weightKg}_{exerciseId}_{timestamp}.mp4
const extractWeightFromS3Key = (s3Key) => {
  if (!s3Key) return null;
  try {
    // s3Key 예: "fitvideo/fitvideo/20_박승민_80_2_20251021160856.mp4"
    const fileName = s3Key.split('/').pop(); // "20_박승민_80_2_20251021160856.mp4"
    const parts = fileName.split('_'); // ["20", "박승민", "80", "2", "20251021160856.mp4"]
    
    if (parts.length >= 3) {
      const weightKg = parseFloat(parts[2]); // 80
      return isNaN(weightKg) ? null : weightKg;
    }
  } catch (error) {
    console.error('S3 키에서 무게 추출 실패:', error);
  }
  return null;
};

// ================================
// 화면/상태
// ================================
const generateSets = () => Array.from({ length: 5 }, (_, i) => ({
  set: i + 1,
  weight: '',
  reps: '',
  feedbackVideo: null,
  analysisVideoUrl: null, // 분석 영상 URL
  memo: '',
  weightLocked: false,
  videoUploaded: false,
}));

export default function MyExerciseScreen({ navigation, route }) {
  const { user, elapsed, isWorkingOut } = useContext(UserContext);
  const [selectedExercise, setSelectedExercise] = useState('squat');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [exerciseSets, setExerciseSets] = useState({
    deadlift: generateSets(),
    squat: generateSets(),
    bench_press: generateSets(),
  });
  const [downloadingVideo, setDownloadingVideo] = useState(false);
  const [dailyTotalReps, setDailyTotalReps] = useState(0);   // ← 총 반복수
  
  // 폴링 상태 추적용 ref
  const wasPollingRef = useRef(false);
  
  // 비디오 플레이어 관련 상태
  const [videoUri, setVideoUri] = useState(null);
  const [showVideoPlayer, setShowVideoPlayer] = useState(false);

  // 임시 함수들 (실제 구현 시 라이브러리 사용)
  const recordAudio = async () => {
    // react-native-audio-record 구현 필요
    return new Promise((resolve) => {
      setTimeout(() => resolve('mock_audio_data'), 2000);
    });
  };

  const playAudio = (audioBlob) => {
    // react-native-sound 구현 필요
    console.log('음성 피드백 재생:', audioBlob);
  };

  // 오늘 날짜를 실시간으로 가져오는 함수
  const getToday = () => new Date();

  const formatDate = (date) =>
    `${date.getFullYear().toString().slice(2)}.${(date.getMonth()+1).toString().padStart(2,'0')}.${date.getDate().toString().padStart(2,'0')}`;

  const formatDateForStorage = (date) =>
    `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2,'0')}-${date.getDate().toString().padStart(2,'0')}`;

  // YYYY-MM-DD 문자열 반환(가독 헬퍼)
  const toYMD = (d) => formatDateForStorage(d);

  // ================================
  // 날짜 관련 함수들
  // ================================
  const changeDate = (direction) => {
    const newDate = new Date(selectedDate);
    if (direction === 'prev') {
      newDate.setDate(newDate.getDate() - 1);
    } else {
      // 오늘 날짜까지만 이동 가능 (내일로는 이동 불가)
      const today = getToday();
      if (newDate.getDate() >= today.getDate() && 
          newDate.getMonth() === today.getMonth() && 
          newDate.getFullYear() === today.getFullYear()) {
        return;
      }
      newDate.setDate(newDate.getDate() + 1);
    }
    setSelectedDate(newDate);
    // 날짜 변경 시 서버 데이터도 함께 불러오기
    loadExerciseSetsFromStorage(newDate);
  };

  const openDatePicker = () => setShowDatePicker(true);

  const onDateChange = (event, picked) => {
    setShowDatePicker(false);
    if (picked) {
      const today = getToday();
      // 오늘 날짜보다 크면 선택 불가
      if (picked.getDate() > today.getDate() || 
          picked.getMonth() > today.getMonth() || 
          picked.getFullYear() > today.getFullYear()) {
        Alert.alert('알림', '오늘 날짜까지만 선택할 수 있습니다.');
        return;
      }
      setSelectedDate(picked);
      loadExerciseSetsFromStorage(picked);
      loadPreviousWorkouts(picked);
    }
  };

  // ================================
  // AsyncStorage 저장/불러오기 + 서버 데이터 병합
  // ================================
  const loadExerciseSetsFromStorage = async (date = selectedDate) => {
    try {
      console.log('🔄 데이터 로딩 시작 - 서버 우선 모드', formatDateForStorage(date));
      
      // 1단계: 서버에서 최신 데이터 가져오기 (서버가 단일 진실 소스)
      await loadExerciseDataFromServer(date, null);

      // 2단계: 서버 데이터가 없는 경우에만 로컬 캐시 확인
      const key = `exerciseSets_${user?.id}_${formatDateForStorage(date)}`;
      const saved = await AsyncStorage.getItem(key);

      if (saved) {
        const localData = JSON.parse(saved);
        // 서버 데이터가 없고 로컬에만 있는 경우 로컬 데이터 사용
        setExerciseSets(prev => {
          // 서버에서 이미 데이터를 받았으면 로컬 데이터 무시
          const hasServerData = prev[selectedExercise]?.some(set => set.videoUploaded);
          if (hasServerData) {
            console.log('✅ 서버 데이터 우선 사용 - 로컬 캐시 무시');
            return prev;
          }
          console.log('ℹ️ 서버 데이터 없음 - 로컬 캐시 사용');
          return localData;
        });
      } else {
        // 로컬 캐시도 없으면 기본 세트로 초기화 (이전 날짜 데이터 제거)
        console.log('ℹ️ 로컬 캐시 없음 - 기본 세트로 초기화');
        setExerciseSets({
          deadlift: generateSets(),
          squat: generateSets(),
          bench_press: generateSets(),
        });
      }

    } catch (e) {
      console.error('세트 데이터 불러오기 실패:', e);
    }
  };

  // 서버에서 특정 날짜의 운동 데이터(생성일 기준) 불러오기 - 서버 우선 모드
  const loadExerciseDataFromServer = async (date, localData = null) => {
    if (!user?.id) return;
    try {
      const ymd = formatDateForStorage(date); // YYYY-MM-DD
      const payload = await apiGetWorkoutsByDate({
        userId: user.id,
        dateYmd: ymd,
        exerciseValue: selectedExercise,
      });

      // 총 reps 상태 반영
      setDailyTotalReps(payload?.total_reps ?? 0);

      const serverList = Array.isArray(payload?.items) ? payload.items : [];

      if (serverList.length > 0) {
        // ✅ 서버 데이터를 직접 state로 변환 (로컬 병합 없이)
        const serverSets = serverList.map((it, idx) => {
          const memoFromAI = aiMemoFromItem(it);
          
          // 무게 데이터 추출: load_kg > weight > S3 키에서 추출
          const weightFromS3 = extractWeightFromS3Key(it.s3_key);
          const weightValue = it.load_kg || it.weight || weightFromS3;
          const weight = weightValue ? String(weightValue) : ''; // 항상 문자열로 변환
          
          // AI 피드백이 있으면 그것을 사용, 없으면 분석 대기 중으로 표시
          let memo;
          if (memoFromAI) {
            memo = memoFromAI; // AI 피드백이 있음
          } else if (weight) {
            memo = '영상 업로드 완료 - 분석 대기 중...'; // 무게는 있지만 AI 피드백 없음 = 분석 중
          } else {
            memo = '피드백 없음'; // 무게도 없고 AI 피드백도 없음
          }
          
          // 분석 영상 URL 추출 (미사용 - presigned URL 방식 사용)
          const analysisVideoUrl = it.video_url || it.analysis_video_url || it.analyzed_video_url || null;
          
          return {
            exercise: selectedExercise,
            weight: weight,
            reps: it.rep_cnt || '',
            memo,
            analysisVideoUrl, // 분석 영상 URL 저장
            weightLocked: !!weight,
            videoUploaded: !!weight, // 서버에 무게 데이터가 있으면 영상 업로드 완료로 간주
          };
        });

        // 서버 세트가 5개 미만이면 빈 세트를 추가하여 최소 5개 유지
        const minSets = 5;
        const finalSets = [...serverSets];
        
        if (finalSets.length < minSets) {
          const emptySetsNeeded = minSets - finalSets.length;
          for (let i = 0; i < emptySetsNeeded; i++) {
            finalSets.push({
              exercise: selectedExercise,
              weight: '',
              reps: '',
              feedbackVideo: null,
              analysisVideoUrl: null,
              memo: '',
              weightLocked: false,
              videoUploaded: false,
            });
          }
          console.log(`📝 서버 세트 ${serverSets.length}개 + 빈 세트 ${emptySetsNeeded}개 = 총 ${finalSets.length}개`);
        }

        // 서버 데이터로 직접 교체 (병합 없이)
        // ⚠️ 주의: 현재 선택된 운동만 교체, 다른 운동은 유지
        const updatedSets = {
          ...exerciseSets,
          [selectedExercise]: finalSets
        };
        
        setExerciseSets(updatedSets);

        // 로컬 캐시 업데이트 (다음 로딩 속도 향상용)
        saveExerciseSetsToStorage(updatedSets, date);
        
        console.log('✅ 서버 데이터로 직접 교체 완료:', `${selectedExercise} ${finalSets.length}개 세트 (서버: ${serverSets.length}개)`);
      } else {
        // 서버 데이터 없음 → 아무것도 하지 않음 (loadExerciseSetsFromStorage에서 처리)
        setDailyTotalReps(0);
        console.log('ℹ️ 서버 데이터 없음 - loadExerciseSetsFromStorage에서 로컬 캐시 또는 기본 세트 처리');
      }
    } catch (e) {
      console.error('❌ 날짜별 서버 데이터 불러오기 실패:', e);
      setDailyTotalReps(0);
    }
  };

  const saveExerciseSetsToStorage = async (sets, date = selectedDate) => {
    try {
      const key = `exerciseSets_${user?.id}_${formatDateForStorage(date)}`;
      await AsyncStorage.setItem(key, JSON.stringify(sets));
      console.log('💾 로컬 캐시 저장 완료');
    } catch (e) {
      console.error('세트 데이터 저장 실패:', e);
    }
  };

  // ================================
  // 이전 운동 기록 불러오기 (AsyncStorage + 서버 데이터 병합)
  // ================================
  const loadPreviousWorkouts = async (date = selectedDate) => {
    try {
      const workouts = [];

      // 최근 7일간의 운동 기록을 불러옴
      for (let i = 1; i <= 7; i++) {
        const checkDate = new Date(date);
        checkDate.setDate(checkDate.getDate() - i);
        const checkDateStr = formatDateForStorage(checkDate);

        // AsyncStorage에서 데이터 확인
        const key = `exerciseSets_${user?.id}_${checkDateStr}`;
        const saved = await AsyncStorage.getItem(key);
        let workoutData = null;

        if (saved) workoutData = JSON.parse(saved);

        // 운동 기록이 있는지 확인
        if (workoutData) {
          const hasWorkout = Object.values(workoutData).some(exercise =>
            exercise.some(set => set.weight && String(set.weight).trim() !== '')
          );

          if (hasWorkout) {
            workouts.push({
              date: checkDateStr,
              displayDate: formatDate(checkDate),
              data: workoutData
            });
          }
        }
      }

      // 필요 시 setPreviousWorkouts(workouts);
    } catch (e) {
      console.error('이전 운동 기록 불러오기 실패:', e);
    }
  };

  // ⚠️ 더 이상 사용하지 않음 - 서버 데이터를 직접 사용하도록 변경됨
  // 서버 우선 모드에서는 로컬과 병합하지 않고 서버 데이터를 그대로 사용

  // ================================
  // 권한/브라우저 열기
  // ================================
  const requestStoragePermission = async () => {
    if (Platform.OS !== 'android') return true;
    try {
      const v = Platform.Version;
      const permission = v >= 33
        ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO
        : PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
      const granted = await PermissionsAndroid.request(permission, {
        title: '저장소 권한',
        message: '영상을 갤러리에 저장하기 위해 저장소 권한이 필요합니다.',
        buttonNeutral: '나중에',
        buttonNegative: '취소',
        buttonPositive: '확인',
      });
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch (err) {
      console.warn('권한 요청 오류:', err);
      return false;
    }
  };

  const openPresignedUrl = async (presignedUrl) => {
    try {
      setDownloadingVideo(true);

      const hasPermission = await requestStoragePermission();
      if (!hasPermission) {
        Alert.alert(
          '권한 필요',
          '영상을 저장하기 위해 저장소 권한이 필요합니다.\n\n설정에서 권한을 허용해주세요.',
          [
            { text: '취소', style: 'cancel' },
            { text: '설정으로 이동', onPress: () => Platform.OS === 'android' && Linking.openSettings() }
          ]
        );
        return;
      }

      Alert.alert(
        '영상 다운로드',
        '피드백 영상을 어떻게 받으시겠습니까?',
        [
          { text: '취소', style: 'cancel' },
          {
            text: '바로 재생하기',
            onPress: () => {
              setVideoUri(presignedUrl);
              setShowVideoPlayer(true);
            }
          },
          {
            text: '브라우저에서 열기',
            onPress: async () => {
              try {
                const supported = await Linking.canOpenURL(presignedUrl);
                if (supported) {
                  await Linking.openURL(presignedUrl);
                  Alert.alert('안내', '브라우저에서 열린 후 "공유 > 저장"으로 기기에 저장하세요.');
                } else {
                  Alert.alert('오류', '브라우저에서 영상을 열 수 없습니다.');
                }
              } catch (e) {
                console.error('영상 열기 오류:', e);
                Alert.alert('오류', '브라우저에서 여는 중 오류가 발생했습니다.');
              } finally {
                setDownloadingVideo(false);
              }
            }
          },
          {
            text: 'URL 복사',
            onPress: () => {
              Alert.alert('영상 URL', presignedUrl);
            }
          }
        ]
      );
    } finally {
      setDownloadingVideo(false);
    }
  };

  // ================================
  // 이벤트 핸들러
  // ================================
  const handleExerciseChange = (val) => {
    saveExerciseSetsToStorage(exerciseSets);
    setSelectedExercise(val);
    // 운동 변경 시 해당 날짜 데이터 갱신
    loadExerciseDataFromServer(selectedDate);
  };

  const handleWeightChange = (idx, value) => {
    // 오늘 날짜가 아닌 경우 무게 수정 불가
    const isToday = selectedDate.toDateString() === getToday().toDateString();
    if (!isToday) return;

    // 이미 잠긴 무게나 영상 업로드된 세트는 수정할 수 없음
    const currentSet = exerciseSets[selectedExercise][idx];
    if (currentSet.weightLocked || (currentSet.memo && currentSet.memo !== '피드백 없음')) return;

    setExerciseSets(prev => {
      const updated = prev[selectedExercise].map((s, i) =>
        i === idx ? { ...s, weight: value } : s
      );
      const next = { ...prev, [selectedExercise]: updated };
      saveExerciseSetsToStorage(next, selectedDate);
      return next;
    });
  };

  const handleVideoUpload = (idx) => {
    // 오늘 날짜가 아닌 경우 영상 업로드 불가
    const isToday = selectedDate.toDateString() === getToday().toDateString();
    if (!isToday) {
      Alert.alert('알림', '오늘 날짜에만 영상 업로드가 가능합니다.');
      return;
    }

    const set = exerciseSets[selectedExercise][idx];
    if (!set.weight || String(set.weight).trim() === '') {
      Alert.alert('알림', '무게를 먼저 입력해주세요.');
      return;
    }

    // 이미 영상 업로드가 완료된 경우
    if (set.videoUploaded || set.weightLocked) {
      Alert.alert('알림', '이미 영상을 업로드한 세트입니다.');
      return;
    }

    // 무게 고정 및 영상 업로드 플래그 설정 (즉시 저장)
    const updatedSets = {
      ...exerciseSets,
      [selectedExercise]: exerciseSets[selectedExercise].map((s, i) =>
        i === idx ? { ...s, weightLocked: true, videoUploaded: true, memo: '영상 업로드 완료 - 분석 대기 중...' } : s
      )
    };
    
    // 즉시 상태 업데이트 및 저장
    setExerciseSets(updatedSets);
    saveExerciseSetsToStorage(updatedSets, selectedDate);

    // 업로드용 키 생성 후 업로드 화면으로 이동 (⚠️ exerciseId 포함)
    const weightVal = set.weight || '0';
    const ts14 = buildTimestamp14();
    const uploadKey = buildUploadKey(user, weightVal, selectedExercise, ts14);

    // 약간의 지연 후 네비게이션 (저장 완료 보장)
    setTimeout(() => {
      navigation.navigate('ExercisePaper', {
        s3KeyName: uploadKey,
        exercise: selectedExercise,                 // 'squat' | 'deadlift' | 'bench_press'
        exerciseId: getExerciseId(selectedExercise) // 1 | 2 | 3
      });
    }, 100);
  };

  const handleSetChange = (idx, field, value) => {
    setExerciseSets(prev => {
      const updated = prev[selectedExercise].map((s, i) =>
        i === idx ? { ...s, [field]: value } : s
      );
      const next = { ...prev, [selectedExercise]: updated };
      // 로컬 캐시에 임시 저장 (서버 업로드 전까지 유지용)
      // ⚠️ 주의: 영상 업로드 후 서버 데이터가 최종 진실 소스가 됨
      saveExerciseSetsToStorage(next);
      return next;
    });
  };

  const handleAddSet = async () => {
    // 오늘 날짜가 아닌 경우 세트 추가 불가
    const isToday = selectedDate.toDateString() === getToday().toDateString();
    if (!isToday) {
      Alert.alert('알림', '오늘 날짜에만 세트를 추가할 수 있습니다.');
      return;
    }

    setExerciseSets(prev => {
      const next = {
        ...prev,
        [selectedExercise]: [
          ...prev[selectedExercise],
          { set: prev[selectedExercise].length + 1, weight: '', reps: '', feedbackVideo: null, analysisVideoUrl: null, memo: '', weightLocked: false, videoUploaded: false }
        ]
      };
      // 로컬 캐시에 즉시 저장 (다른 화면 갔다 와도 유지되도록)
      // ⚠️ 주의: 영상 업로드 전까지만 로컬에 유지, 업로드 후 서버 데이터로 교체됨
      saveExerciseSetsToStorage(next, selectedDate).then(() => {
        console.log('✅ 세트 추가 후 로컬 캐시 저장 완료');
        // 서버에서 최신 데이터 확인
        fetchFeedback();
      });
      return next;
    });
  };

  // ✅ 선택된 날짜 + n번째 세트 → presign(get) 호출 (과거 날짜도 가능)
  const handleGetFeedbackWithVideo = async (setIndex) => {
    try {
      const url = await getAnalyzedPresignedUrlByDateSet({
        user,
        dateYmd: toYYYYMMDD(selectedDate),
        setNo: setIndex + 1,
        exerciseValue: selectedExercise,
        download: true,
      });
      await openPresignedUrl(url);

    } catch (error) {
      console.error('❌ 피드백 받기 오류:', error);
      let errorMessage = '피드백 영상 URL 발급 중 문제가 발생했습니다.';
      if (String(error.message).includes('404')) errorMessage = '해당 날짜/세트의 피드백 영상을 찾을 수 없습니다.';
      else if (String(error.message).includes('500')) errorMessage = '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      else if (String(error.message).includes('URL')) errorMessage = '서버에서 영상 URL을 제공하지 못했습니다.';
      Alert.alert('피드백 영상 오류', errorMessage);
    }
  };

  // ================================
  // 피드백 메모 갱신(선택된 날짜, 선택 운동만)
  // ================================
  const fetchFeedback = async () => {
    if (!user?.id) return;
    try {
      const ymd = formatDateForStorage(selectedDate);
      const payload = await apiGetWorkoutsByDate({
        userId: user.id,
        dateYmd: ymd,
        exerciseValue: selectedExercise,
      });

      setDailyTotalReps(payload?.total_reps ?? 0);

      const list = Array.isArray(payload?.items) ? payload.items : [];
      if (list.length > 0) {
        const serverData = list.map((item, idx) => {
          const memoFromAI = aiMemoFromItem(item);
          
          // 무게 데이터 추출: load_kg > weight > S3 키에서 추출
          const weightFromS3 = extractWeightFromS3Key(item.s3_key);
          const weightValue = item.load_kg || item.weight || weightFromS3;
          const weight = weightValue ? String(weightValue) : ''; // 항상 문자열로 변환
          
          // AI 피드백이 있으면 그것을 사용, 없으면 분석 대기 중으로 표시
          let memo;
          if (memoFromAI) {
            memo = memoFromAI; // AI 피드백이 있음
          } else if (weight) {
            memo = '영상 업로드 완료 - 분석 대기 중...'; // 무게는 있지만 AI 피드백 없음 = 분석 중
          } else {
            memo = '피드백 없음'; // 무게도 없고 AI 피드백도 없음
          }
          
          // 분석 영상 URL 추출 (미사용 - presigned URL 방식 사용)
          const analysisVideoUrl = item.video_url || item.analysis_video_url || item.analyzed_video_url || null;
          
          return {
            exercise: selectedExercise,
            weight: weight,
            reps: item.rep_cnt || '',
            memo,
            analysisVideoUrl, // 분석 영상 URL 저장
            weightLocked: !!weight,
            videoUploaded: !!weight, // 서버에 무게 데이터가 있으면 영상 업로드 완료로 간주
          };
        });

        setExerciseSets(prev => {
          const updated = { ...prev };
          updated[selectedExercise] = updated[selectedExercise].map((set, idx) => {
            const serverSet = serverData[idx];
            if (serverSet) {
              // 서버 데이터가 있으면 병합하되, 로컬의 videoUploaded 상태 보존
              return {
                ...set,
                ...serverSet,
                videoUploaded: serverSet.videoUploaded || set.videoUploaded, // 로컬 상태 보존
              };
            }
            return set;
          });
          saveExerciseSetsToStorage(updated, selectedDate);
          return updated;
        });
      } else {
        setDailyTotalReps(0);
      }
    } catch (e) {
      console.error('피드백 데이터 불러오기 실패:', e);
      setDailyTotalReps(0);
    }
  };

  useFocusEffect(React.useCallback(() => {
    const loadData = async () => {
      await loadExerciseSetsFromStorage(selectedDate);
      await loadPreviousWorkouts(selectedDate);
      await fetchFeedback(); // 서버 데이터 확인하여 업로드 상태 동기화
    };
    loadData();
    // checkCheckInStatus(); // 알람 제거됨
  }, [selectedDate, selectedExercise]));

  // 하드웨어 백 버튼 핸들러
  useFocusEffect(
    React.useCallback(() => {
      const onBackPress = () => {
        navigation.goBack();
        return true;
      };

      const backHandler = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => backHandler.remove();
    }, [navigation])
  );

  // 입실 상태 확인 함수 (알람 제거됨)
  const checkCheckInStatus = async () => {
    try {
      const checkInTime = await AsyncStorage.getItem('checkInTime');
      if (!checkInTime) {
        navigation.navigate('CheckIn');
      }
    } catch (error) {
      console.error('입실 상태 확인 중 오류:', error);
    }
  };

  useEffect(() => { fetchFeedback(); }, [user?.id, selectedExercise, selectedDate]);

  // 영상 업로드 완료 후 자동 새로고침
  useEffect(() => {
    if (route?.params?.videoUploaded) {
      console.log('✅ 영상 업로드 완료 감지 - 자동 새로고침');
      fetchFeedback();
      // 파라미터 초기화 (한 번만 실행되도록)
      navigation.setParams({ videoUploaded: false, timestamp: undefined });
    }
  }, [route?.params?.videoUploaded, route?.params?.timestamp]);

  // AI 피드백 & 분석 영상 대기 중인 세트가 있으면 5초마다 확인
  useEffect(() => {
    // 현재 선택된 운동의 세트 중에 분석 대기 중이거나 분석 영상 URL이 없는 세트가 있는지 확인
    const currentSets = exerciseSets[selectedExercise] || [];
    const hasWaitingSets = currentSets.some(set => 
      set.videoUploaded && (
        set.memo === '영상 업로드 완료 - 분석 대기 중...' || // AI 피드백 대기 중
        !set.analysisVideoUrl // 분석 영상 URL이 아직 생성되지 않음
      )
    );

    // 폴링 중지 시 최종 새로고침 처리
    if (!hasWaitingSets && wasPollingRef.current) {
      console.log('⏹️ AI 피드백 & 분석 영상 폴링 중지 - 최종 새로고침 실행');
      wasPollingRef.current = false;
      // 비동기로 최종 새로고침 실행
      setTimeout(() => {
        fetchFeedback();
      }, 100);
      return;
    }

    if (!hasWaitingSets) {
      wasPollingRef.current = false;
      return; // 대기 중인 세트가 없으면 폴링 안 함
    }

    console.log('🔄 AI 피드백 & 분석 영상 대기 중 - 10초마다 확인 시작');
    wasPollingRef.current = true; // 폴링 시작 표시
    
    // 10초마다 서버에서 AI 피드백 & 분석 영상 URL 확인
    const intervalId = setInterval(() => {
      console.log('⏰ AI 피드백 & 분석 영상 확인 중...');
      fetchFeedback();
    }, 10000); // 10초

    // cleanup: 컴포넌트 언마운트 또는 의존성 변경 시 interval 제거
    return () => {
      clearInterval(intervalId);
    };
  }, [exerciseSets, selectedExercise]);


  // 앱 상태 변화 감지 및 강제퇴실 기능
  useEffect(() => {
    let backgroundTimer = null;
    let isLoggedOut = false;

    const handleAppStateChange = (nextAppState) => {
      if (nextAppState === 'active') {
        if (backgroundTimer) {
          clearTimeout(backgroundTimer);
          backgroundTimer = null;
        }
      }
    };

    const handleForceLogout = async () => {
      if (isLoggedOut) return;
      isLoggedOut = true;

      try {
        await AsyncStorage.removeItem('user');
        await AsyncStorage.removeItem('userToken');

        const keys = await AsyncStorage.getAllKeys();
        const exerciseKeys = keys.filter(key => key.startsWith(`exerciseSets_${user?.id}_`));
        await AsyncStorage.multiRemove(exerciseKeys);

        Alert.alert(
          '강제 로그아웃',
          '앱이 종료되어 자동으로 로그아웃되었습니다.',
          [
            {
              text: '확인',
              onPress: () => {
                navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
              }
            }
          ]
        );
      } catch (error) {
        console.error('강제 로그아웃 처리 오류:', error);
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      subscription?.remove();
      if (backgroundTimer) clearTimeout(backgroundTimer);
    };
  }, [navigation]);

  // ================================
  // UI
  // ================================
  const sets = exerciseSets[selectedExercise];
  const selectedExerciseInfo = exerciseTypes.find(e => e.value === selectedExercise);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={gymTheme.colors.primary} />

      {/* 헤더 */}
      <View style={styles.header}>
        <View style={styles.dateHeader}>
          <TouchableOpacity onPress={() => changeDate('prev')} style={styles.dateArrow}>
            <Text style={styles.dateArrowText}>◀</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={openDatePicker} style={styles.dateSelector}>
            <Text style={styles.dateText}>{formatDate(selectedDate)}</Text>
            <Text style={styles.dateSelectorText}>📅 날짜 변경</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => changeDate('next')} style={styles.dateArrow}>
            <Text style={styles.dateArrowText}>▶</Text>
          </TouchableOpacity>
        </View>

        <CommonHeader
          navigation={navigation}
          title="운동 기록"
        />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        {/* 운동 선택 카드 */}
        <View style={styles.exerciseCard}>
          <View style={styles.exerciseHeader}>
            <Text style={styles.exerciseIcon}>{selectedExerciseInfo.icon}</Text>
            <Text style={styles.exerciseName}>{selectedExerciseInfo.label}</Text>
          </View>

          <View style={styles.pickerContainer}>
            <Picker
              selectedValue={selectedExercise}
              style={styles.picker}
              onValueChange={handleExerciseChange}
              itemStyle={{ color: gymTheme.colors.text }}
            >
              {exerciseTypes.map((ex) => (
                <Picker.Item
                  key={ex.value}
                  label={`${ex.icon} ${ex.label}`}
                  value={ex.value}
                  color={gymTheme.colors.text}
                />
              ))}
            </Picker>
          </View>
        </View>

        {/* 세트 목록 */}
        <View style={styles.setsContainer}>
          <View style={styles.setsHeader}>
            <Text style={styles.setsTitle}>{formatDate(selectedDate)}의 세트</Text>
            <Text style={{ color: gymTheme.colors.accent, fontWeight: 'bold' }}>
              🔢 총 반복수: {dailyTotalReps}
            </Text>
          </View>

          {sets.map((set, idx) => {
            const isToday = selectedDate.toDateString() === getToday().toDateString();
            const isAnalyzed = !!set.memo && set.memo !== '피드백 없음'; // ✅ AI 피드백이 있으면 분석완료로 간주
            return (
              <View key={idx} style={styles.setCard}>
                <View style={styles.setHeader}>
                  <Text style={styles.setNumber}>{set.set}세트</Text>

                  <View style={styles.weightContainer}>
                    <TextInput
                      style={[
                        styles.weightInput,
                        !set.weight || String(set.weight).trim() === '' ? styles.weightInputRequired : null,
                        (set.weightLocked || isAnalyzed || !isToday) ? styles.weightInputLocked : null
                      ]}
                      value={set.weight?.toString() ?? ''}
                      onChangeText={txt => handleWeightChange(idx, txt.replace(/[^0-9]/g, '').slice(0,3))}
                      keyboardType="numeric"
                      maxLength={3}
                      placeholder="무게"
                      placeholderTextColor={gymTheme.colors.textMuted}
                      editable={!set.weightLocked && !isAnalyzed && isToday}
                    />
                    <Text style={styles.weightUnit}>kg</Text>
                  </View>
                </View>

                <View style={styles.setContent}>
                  {/* 분석 대기 중 표시 */}
                  {set.videoUploaded && (!set.memo || set.memo === '영상 업로드 완료 - 분석 대기 중...') && (
                    <View style={styles.waitingContainer}>
                      <View style={styles.waitingHeader}>
                        <Text style={styles.waitingIcon}>⏳</Text>
                        <Text style={styles.waitingTitle}>AI 분석 진행 중</Text>
                      </View>
                      <Text style={styles.waitingText}>
                        업로드한 영상을 AI가 분석하고 있습니다.{'\n'}
                        잠시만 기다려주세요!
                      </Text>
                      <View style={styles.waitingSteps}>
                        <View style={styles.waitingStep}>
                          <Text style={styles.stepIcon}>✓</Text>
                          <Text style={styles.stepText}>영상 업로드 완료</Text>
                        </View>
                        <View style={styles.waitingStep}>
                          <Text style={styles.stepIconActive}>⟳</Text>
                          <Text style={styles.stepTextActive}>자세 분석 중...</Text>
                        </View>
                        <View style={styles.waitingStep}>
                          <Text style={styles.stepIconPending}>○</Text>
                          <Text style={styles.stepTextPending}>피드백 생성 대기</Text>
                        </View>
                      </View>
                    </View>
                  )}

                  {/* AI 피드백 표시 영역 */}
                  {set.memo && set.memo !== '피드백 없음' && set.memo !== '영상 업로드 완료 - 분석 대기 중...' && (
                    <View style={styles.memoContainer}>
                      <Text style={styles.memoLabel}>🤖 AI Feedback:</Text>
                      {(() => {
                        try {
                          let feedback = set.memo;
                          
                          // JSON 문자열인 경우 파싱 시도
                          if (typeof set.memo === 'string') {
                            const trimmed = set.memo.trim();
                            
                            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                              try {
                                feedback = JSON.parse(trimmed);
                              } catch (parseError) {
                                // JSON 파싱 실패 시 원본 텍스트 사용
                              }
                            }
                          }
                          
                          // JSON 객체인 경우 구조화된 형태로 표시
                          if (typeof feedback === 'object' && feedback !== null && !Array.isArray(feedback)) {
                            return (
                              <View style={styles.feedbackStructured}>
                                {feedback.headline && (
                                  <Text style={styles.feedbackHeadline}>{feedback.headline}</Text>
                                )}
                                
                                {feedback.positives && Array.isArray(feedback.positives) && feedback.positives.length > 0 && (
                                  <View style={styles.feedbackSection}>
                                    <Text style={styles.feedbackSectionTitle}>✅ 잘한 점:</Text>
                                    {feedback.positives.map((item, i) => (
                                      <Text key={`positive-${i}`} style={styles.feedbackItem}>• {item}</Text>
                                    ))}
                                  </View>
                                )}
                                
                                {feedback.improvements && Array.isArray(feedback.improvements) && feedback.improvements.length > 0 && (
                                  <View style={styles.feedbackSection}>
                                    <Text style={styles.feedbackSectionTitle}>⚠️ 개선 필요:</Text>
                                    {feedback.improvements.map((item, i) => (
                                      <Text key={`improvement-${i}`} style={styles.feedbackItem}>• {item}</Text>
                                    ))}
                                  </View>
                                )}
                                
                                {feedback.action_items && Array.isArray(feedback.action_items) && feedback.action_items.length > 0 && (
                                  <View style={styles.feedbackSection}>
                                    <Text style={styles.feedbackSectionTitle}>💡 실천 방법:</Text>
                                    {feedback.action_items.map((item, i) => (
                                      <Text key={`action-${i}`} style={styles.feedbackItem}>• {item}</Text>
                                    ))}
                                  </View>
                                )}
                              </View>
                            );
                          }
                          
                          // 문자열인 경우 그대로 표시
                          return <Text style={styles.memoText}>{String(feedback)}</Text>;
                        } catch (error) {
                          // 오류 발생 시 원본 텍스트 표시
                          return <Text style={styles.memoText}>{set.memo}</Text>;
                        }
                      })()}
                    </View>
                  )}

                  {/* 분석 영상 보기 버튼 - AI 피드백이 있을 때 표시 */}
                  {(() => {
                    // AI 피드백이 유효한지 확인
                    if (!set.memo || set.memo === '피드백 없음' || set.memo === '영상 업로드 완료 - 분석 대기 중...') {
                      return null;
                    }
                    
                    // JSON 파싱 시도
                    try {
                      const parsed = JSON.parse(set.memo);
                      if (parsed && typeof parsed === 'object' && (parsed.headline || parsed.positives || parsed.improvements || parsed.action_items)) {
                        // 유효한 AI 피드백이 있음 - 버튼 표시
                        return (
                          <TouchableOpacity
                            style={styles.analysisVideoButton}
                            onPress={() => handleGetFeedbackWithVideo(idx)}
                          >
                            <Text style={styles.analysisVideoButtonText}>📹 분석 영상 보기</Text>
                          </TouchableOpacity>
                        );
                      }
                    } catch (error) {
                      // JSON이 아니지만 텍스트 피드백이 있을 수 있음
                      if (set.memo.length > 5) {
                        return (
                          <TouchableOpacity
                            style={styles.analysisVideoButton}
                            onPress={() => handleGetFeedbackWithVideo(idx)}
                          >
                            <Text style={styles.analysisVideoButtonText}>📹 분석 영상 보기</Text>
                          </TouchableOpacity>
                        );
                      }
                    }
                    return null;
                  })()}

                  {!isAnalyzed && !set.videoUploaded ? (
                    isToday ? (
                      <TouchableOpacity
                        style={[
                          styles.uploadButton,
                          (!set.weight || String(set.weight).trim() === '' || set.videoUploaded) ? styles.uploadButtonDisabled : null
                        ]}
                        onPress={() => handleVideoUpload(idx)}
                        disabled={!set.weight || String(set.weight).trim() === '' || set.videoUploaded}>
                        <View style={[
                          styles.uploadContainer,
                          set.weight && String(set.weight).trim() !== '' && !set.videoUploaded ? styles.uploadActive : styles.uploadInactive
                        ]}>
                          <Text style={styles.uploadIcon}>📹</Text>
                          <Text style={styles.uploadText}>영상 업로드</Text>
                        </View>
                      </TouchableOpacity>
                    ) : (
                      <View style={styles.uploadDisabledContainer}>
                        <Text style={styles.uploadDisabledIcon}>📹</Text>
                        <Text style={styles.uploadDisabledText}>오늘만 가능</Text>
                      </View>
                    )
                  ) : null}
                </View>
              </View>
            );
          })}

          {/* 세트 추가 - 오늘 날짜에만 표시 */}
          {selectedDate.toDateString() === getToday().toDateString() && (
            <TouchableOpacity style={styles.addSetButton} onPress={handleAddSet}>
              <Text style={styles.addSetText}>+ 세트 추가</Text>
            </TouchableOpacity>
          )}
        </View>


        {/* 새로고침 */}
        <TouchableOpacity style={styles.refreshButton} onPress={fetchFeedback}>
          <View style={styles.refreshContainer}>
            <Text style={styles.refreshText}>🔄 {formatDate(selectedDate)} 피드백 새로고침</Text>
          </View>
        </TouchableOpacity>

        {/* 디버깅용 테스트 버튼 */}
      </ScrollView>

      {/* 날짜 선택 모달 */}
      <Modal visible={showDatePicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>날짜 선택</Text>
            <View style={styles.datePickerContainer}>
              <Picker
                selectedValue={selectedDate.getFullYear()}
                style={[styles.yearPicker, { 
                  color: '#000000', 
                  backgroundColor: '#ffffff',
                  fontSize: 16,
                  fontWeight: 'bold'
                }]}
                itemStyle={{ 
                  color: '#000000', 
                  backgroundColor: '#ffffff',
                  fontSize: 16,
                  fontWeight: 'bold'
                }}
                onValueChange={(year) => {
                  const newDate = new Date(selectedDate);
                  newDate.setFullYear(year);
                  const today = getToday();
                  if (newDate.getFullYear() > today.getFullYear() ||
                      (newDate.getFullYear() === today.getFullYear() && newDate.getMonth() > today.getMonth()) ||
                      (newDate.getFullYear() === today.getFullYear() && newDate.getMonth() === today.getMonth() && newDate.getDate() > today.getDate())) {
                    return;
                  }
                  setSelectedDate(newDate);
                }}
              >
                {Array.from({ length: 10 }, (_, i) => getToday().getFullYear() - 5 + i).map(year => (
                  <Picker.Item key={year} label={String(year)} value={year} color="#000000" style={{color: '#000000', fontSize: 16, fontWeight: 'bold'}} />
                ))}
              </Picker>
              <Picker
                selectedValue={selectedDate.getMonth() + 1}
                style={[styles.monthPicker, { 
                  color: '#000000', 
                  backgroundColor: '#ffffff',
                  fontSize: 16,
                  fontWeight: 'bold'
                }]}
                itemStyle={{ 
                  color: '#000000', 
                  backgroundColor: '#ffffff',
                  fontSize: 16,
                  fontWeight: 'bold'
                }}
                onValueChange={(month) => {
                  const newDate = new Date(selectedDate);
                  newDate.setMonth(month - 1);
                  const today = getToday();
                  if (newDate.getFullYear() > today.getFullYear() ||
                      (newDate.getFullYear() === today.getFullYear() && newDate.getMonth() > today.getMonth()) ||
                      (newDate.getFullYear() === today.getFullYear() && newDate.getMonth() === today.getMonth() && newDate.getDate() > today.getDate())) {
                    return;
                  }
                  setSelectedDate(newDate);
                }}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map(month => (
                  <Picker.Item key={month} label={String(month)} value={month} color="#000000" style={{color: '#000000', fontSize: 16, fontWeight: 'bold'}} />
                ))}
              </Picker>
              <Picker
                selectedValue={selectedDate.getDate()}
                style={[styles.dayPicker, { 
                  color: '#000000', 
                  backgroundColor: '#ffffff',
                  fontSize: 16,
                  fontWeight: 'bold'
                }]}
                itemStyle={{ 
                  color: '#000000', 
                  backgroundColor: '#ffffff',
                  fontSize: 16,
                  fontWeight: 'bold'
                }}
                onValueChange={(day) => {
                  const newDate = new Date(selectedDate);
                  newDate.setDate(day);
                  const today = getToday();
                  if (newDate.getFullYear() > today.getFullYear() ||
                      (newDate.getFullYear() === today.getFullYear() && newDate.getMonth() > today.getMonth()) ||
                      (newDate.getFullYear() === today.getFullYear() && newDate.getMonth() === today.getMonth() && newDate.getDate() > today.getDate())) {
                    return;
                  }
                  setSelectedDate(newDate);
                }}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map(day => (
                  <Picker.Item key={day} label={String(day)} value={day} color="#000000" style={{color: '#000000', fontSize: 16, fontWeight: 'bold'}} />
                ))}
              </Picker>
            </View>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalButton} onPress={() => setShowDatePicker(false)}>
                <Text style={styles.modalButtonText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={() => {
                  setShowDatePicker(false);
                  loadExerciseSetsFromStorage();
                  loadPreviousWorkouts();
                }}
              >
                <Text style={styles.modalButtonText}>확인</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 비디오 플레이어 모달 */}
      <Modal visible={showVideoPlayer} transparent animationType="slide">
        <View style={styles.videoPlayerContainer}>
          <Video
            source={{ uri: videoUri }}
            style={styles.videoPlayer}
            controls={true}
            resizeMode="contain"
            onError={(error) => {
              console.error('비디오 재생 오류:', error);
              Alert.alert('오류', '비디오를 재생할 수 없습니다.');
            }}
            onEnd={() => {
              setShowVideoPlayer(false);
              setVideoUri(null);
            }}
          />
          <TouchableOpacity
            style={styles.videoCloseButton}
            onPress={() => {
              setShowVideoPlayer(false);
              setVideoUri(null);
            }}
          >
            <Text style={styles.videoCloseButtonText}>✕</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

// ================================
// Styles
// ================================
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: gymTheme.colors.primary },
  header: {
    backgroundColor: gymTheme.colors.secondary,
    paddingTop: 50,
    paddingBottom: 20,
    paddingHorizontal: gymTheme.spacing.lg,
    alignItems: 'center',
  },
  dateHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 10,
  },
  dateArrow: { padding: 10 },
  dateArrowText: { fontSize: 20, color: gymTheme.colors.accent, fontWeight: 'bold' },
  dateSelector: { alignItems: 'center', marginHorizontal: 20 },
  dateText: {
    fontSize: 18, color: gymTheme.colors.text, fontWeight: 'bold', marginBottom: 4,
  },
  dateSelectorText: { fontSize: 12, color: gymTheme.colors.accent },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: gymTheme.colors.text, marginBottom: 10 },

  scrollView: { flex: 1 },
  content: { padding: gymTheme.spacing.lg },

  exerciseCard: {
    backgroundColor: gymTheme.colors.card, borderRadius: gymTheme.borderRadius.large,
    padding: gymTheme.spacing.lg, marginBottom: gymTheme.spacing.lg, ...gymTheme.shadows.medium,
  },
  exerciseHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: gymTheme.spacing.md },
  exerciseIcon: { fontSize: 24, marginRight: gymTheme.spacing.sm },
  exerciseName: { fontSize: 20, fontWeight: 'bold', color: gymTheme.colors.text },
  pickerContainer: {
    backgroundColor: '#2a2a2a', borderRadius: gymTheme.borderRadius.medium,
    borderWidth: 1, borderColor: gymTheme.colors.border,
  },
  picker: { 
    color: gymTheme.colors.text, 
    backgroundColor: gymTheme.colors.input,
    fontSize: 16,
  },

  setsContainer: { marginBottom: gymTheme.spacing.lg },
  setsHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: gymTheme.spacing.md,
  },
  setsTitle: { fontSize: 18, fontWeight: 'bold', color: gymTheme.colors.text },

  setCard: {
    backgroundColor: gymTheme.colors.card, borderRadius: gymTheme.borderRadius.large,
    padding: gymTheme.spacing.lg, marginBottom: gymTheme.spacing.md, ...gymTheme.shadows.medium,
  },
  setHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: gymTheme.spacing.md,
  },
  setNumber: { fontSize: 16, fontWeight: 'bold', color: gymTheme.colors.accent },

  weightContainer: { flexDirection: 'row', alignItems: 'center' },
  weightInput: {
    width: 60, height: 40, borderWidth: 1, borderColor: gymTheme.colors.border,
    borderRadius: gymTheme.borderRadius.small, textAlign: 'center', marginRight: 8,
    backgroundColor: gymTheme.colors.input, color: gymTheme.colors.text, fontSize: 16,
  },
  weightInputLocked: {
    backgroundColor: gymTheme.colors.success,
    borderColor: gymTheme.colors.success,
    color: '#FFFFFF', 
    fontWeight: 'bold',
  },
  weightUnit: { fontSize: 16, color: gymTheme.colors.textSecondary, marginRight: 8 },

  setContent: { marginBottom: gymTheme.spacing.md },
  
  // 분석 대기 중 스타일
  waitingContainer: {
    backgroundColor: '#1a1a2e',
    borderRadius: gymTheme.borderRadius.md,
    padding: gymTheme.spacing.lg,
    marginBottom: gymTheme.spacing.md,
    borderWidth: 2,
    borderColor: gymTheme.colors.accent,
    ...gymTheme.shadows.medium,
  },
  waitingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: gymTheme.spacing.md,
  },
  waitingIcon: {
    fontSize: 24,
    marginRight: gymTheme.spacing.sm,
  },
  waitingTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: gymTheme.colors.accent,
  },
  waitingText: {
    fontSize: 14,
    color: gymTheme.colors.textSecondary,
    lineHeight: 20,
    marginBottom: gymTheme.spacing.md,
    textAlign: 'center',
  },
  waitingSteps: {
    marginTop: gymTheme.spacing.sm,
  },
  waitingStep: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: gymTheme.spacing.sm,
  },
  stepIcon: {
    fontSize: 16,
    color: gymTheme.colors.success,
    marginRight: gymTheme.spacing.sm,
    width: 20,
  },
  stepIconActive: {
    fontSize: 16,
    color: gymTheme.colors.accent,
    marginRight: gymTheme.spacing.sm,
    width: 20,
  },
  stepIconPending: {
    fontSize: 16,
    color: gymTheme.colors.textMuted,
    marginRight: gymTheme.spacing.sm,
    width: 20,
  },
  stepText: {
    fontSize: 13,
    color: gymTheme.colors.success,
  },
  stepTextActive: {
    fontSize: 13,
    color: gymTheme.colors.accent,
    fontWeight: 'bold',
  },
  stepTextPending: {
    fontSize: 13,
    color: gymTheme.colors.textMuted,
  },

  memoContainer: { marginBottom: gymTheme.spacing.md },
  memoLabel: { 
    fontSize: 16, 
    color: gymTheme.colors.accent, 
    marginBottom: gymTheme.spacing.sm,
    fontWeight: 'bold',
  },
  memoText: {
    fontSize: 14, 
    color: gymTheme.colors.textPrimary, 
    backgroundColor: gymTheme.colors.cardElevated,
    padding: gymTheme.spacing.md, 
    borderRadius: gymTheme.borderRadius.md, 
    minHeight: 50,
    lineHeight: 20,
    borderLeftWidth: 3,
    borderLeftColor: gymTheme.colors.accent,
    ...gymTheme.shadows.small,
  },

  // 구조화된 AI 피드백 스타일
  feedbackStructured: {
    backgroundColor: gymTheme.colors.cardElevated,
    padding: gymTheme.spacing.md,
    borderRadius: gymTheme.borderRadius.md,
    borderLeftWidth: 3,
    borderLeftColor: gymTheme.colors.accent,
    ...gymTheme.shadows.small,
  },
  feedbackHeadline: {
    fontSize: 15,
    fontWeight: 'bold',
    color: gymTheme.colors.accent,
    marginBottom: gymTheme.spacing.sm,
    lineHeight: 21,
    flexWrap: 'wrap', // 텍스트 줄바꿈
  },
  feedbackSection: {
    marginTop: gymTheme.spacing.sm,
  },
  feedbackSectionTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: gymTheme.colors.textPrimary,
    marginBottom: gymTheme.spacing.xs,
    flexWrap: 'wrap',
  },
  feedbackItem: {
    fontSize: 12,
    color: gymTheme.colors.textSecondary,
    lineHeight: 18,
    marginBottom: gymTheme.spacing.xs,
    paddingLeft: gymTheme.spacing.sm,
    flexWrap: 'wrap', // 텍스트 줄바꿈
    flexShrink: 1, // 텍스트가 컨테이너에 맞게 축소
  },


  uploadButton: { borderRadius: gymTheme.borderRadius.medium, overflow: 'hidden' },
  uploadButtonDisabled: { opacity: 0.5 },
  uploadContainer: {
    paddingVertical: gymTheme.spacing.md, alignItems: 'center', justifyContent: 'center',
    borderRadius: gymTheme.borderRadius.medium,
  },
  uploadActive: { backgroundColor: gymTheme.colors.accent },
  uploadInactive: { backgroundColor: '#555555' },
  uploadIcon: { fontSize: 20, marginBottom: 4 },
  uploadText: { color: gymTheme.colors.text, fontWeight: '600', fontSize: 14 },

  addSetButton: {
    backgroundColor: gymTheme.colors.accent, paddingHorizontal: gymTheme.spacing.md,
    paddingVertical: gymTheme.spacing.sm, borderRadius: gymTheme.borderRadius.medium,
  },
  addSetText: { color: gymTheme.colors.text, fontWeight: '600', fontSize: 14 },

  refreshButton: { borderRadius: gymTheme.borderRadius.medium, overflow: 'hidden', marginTop: gymTheme.spacing.md },
  refreshContainer: {
    paddingVertical: gymTheme.spacing.md, alignItems: 'center',
    backgroundColor: gymTheme.colors.accent, borderRadius: gymTheme.borderRadius.medium,
  },
  refreshText: { color: gymTheme.colors.text, fontWeight: '600', fontSize: 16 },

  // 음성 피드백 스타일
  voiceFeedbackContainer: {
    backgroundColor: gymTheme.colors.cardElevated,
    borderRadius: gymTheme.borderRadius.md,
    padding: gymTheme.spacing.md,
    marginTop: gymTheme.spacing.sm,
    borderLeftWidth: 4,
    borderLeftColor: gymTheme.colors.accent,
    ...gymTheme.shadows.small,
  },
  voiceFeedbackText: {
    color: gymTheme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
    fontStyle: 'italic',
  },


  // 분석 영상 보기 버튼 스타일
  analysisVideoButton: {
    backgroundColor: gymTheme.colors.highlight,
    borderRadius: gymTheme.borderRadius.md,
    paddingVertical: gymTheme.spacing.sm,
    paddingHorizontal: gymTheme.spacing.md,
    marginTop: gymTheme.spacing.sm,
    alignItems: 'center',
    ...gymTheme.shadows.small,
  },
  analysisVideoButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },


  uploadingContainer: {
    paddingVertical: gymTheme.spacing.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: gymTheme.colors.warning || '#FFA500', borderRadius: gymTheme.borderRadius.medium,
  },
  uploadingIcon: { fontSize: 20, marginBottom: 4 },
  uploadingText: { color: gymTheme.colors.text, fontWeight: '600', fontSize: 14 },

  uploadDisabledContainer: {
    paddingVertical: gymTheme.spacing.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#666666', borderRadius: gymTheme.borderRadius.medium,
  },
  uploadDisabledIcon: { fontSize: 20, marginBottom: 4 },
  uploadDisabledText: { color: gymTheme.colors.textMuted, fontWeight: '600', fontSize: 14 },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'center', alignItems: 'center',
  },
  modalContent: {
    backgroundColor: gymTheme.colors.card, borderRadius: gymTheme.borderRadius.large,
    padding: gymTheme.spacing.lg, width: '90%', maxHeight: '80%', ...gymTheme.shadows.large,
  },
  modalTitle: {
    fontSize: 20, fontWeight: 'bold', color: gymTheme.colors.text, textAlign: 'center',
    marginBottom: gymTheme.spacing.lg,
  },
  datePickerContainer: {
    flexDirection: 'row', justifyContent: 'space-around', marginBottom: gymTheme.spacing.lg,
  },
  yearPicker: { 
    width: 70, 
    height: 100, 
    color: '#000000',
    backgroundColor: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  monthPicker: { 
    width: 70, 
    height: 100, 
    color: '#000000',
    backgroundColor: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  dayPicker: {
    width: 70, 
    height: 100, 
    color: '#000000',
    backgroundColor: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-around' },
  modalButton: {
    backgroundColor: gymTheme.colors.input, paddingHorizontal: gymTheme.spacing.lg,
    paddingVertical: gymTheme.spacing.md, borderRadius: gymTheme.borderRadius.medium,
    minWidth: 100, alignItems: 'center',
  },
  modalButtonConfirm: { backgroundColor: gymTheme.colors.accent },
  modalButtonText: { color: gymTheme.colors.text, fontWeight: '600', fontSize: 16 },
  
  // 비디오 플레이어 관련 스타일
  videoPlayerContainer: {
    flex: 1,
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoPlayer: {
    width: '100%',
    height: '100%',
  },
  videoCloseButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  videoCloseButtonText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },

});