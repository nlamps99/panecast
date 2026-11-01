import { Text, View, StyleSheet } from "react-native";

export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Panecast</Text>
      <Text style={styles.subtitle}>在手机上查看和操作电脑上的终端</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1a1b26",
  },
  title: {
    color: "#c0caf5",
    fontSize: 28,
    fontWeight: "600",
  },
  subtitle: {
    color: "#565f89",
    fontSize: 14,
    marginTop: 8,
  },
});
